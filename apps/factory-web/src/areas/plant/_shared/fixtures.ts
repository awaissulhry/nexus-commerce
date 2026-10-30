import { createElement, type ReactNode } from 'react'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { permissionCheck } from '../../../lib/session/session'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER } from '../../../shell/design-data'
import { officeNavFor } from '../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../shell/office/view/OfficeShellView'
import type { JobBrief, Machine, MachineCard, MachineClass, MaintenanceJob, MaintenanceRequest, Person, PlantSite, RequestTiles, JobTiles, MachineTiles, Symptom, Technician } from './api'
import { plantCan, type PlantCan } from './model'

/**
 * Made-up data for the Plant maintenance pages' design cases (SCR-148, SCR-149, SCR-150 and their records and print
 * pages): an invented company ("Officina Demo"), a site ("STAB-N") with lines, stations and work centres, machines with
 * invented makes and serial numbers ("DEMO-SEW-01" …), requests, jobs ("MJ-D-0001" …) and people ("Anna Esempio",
 * "Marco Prova", a floor technician "Luca Demo"). Nothing here is a real company, person, machine or number. Design-only
 * (only fixtures and tests import it: `check-view-boundaries`); it exports no `designScreen`.
 */

export const PREFIX = '/w/DEMO'
export const COMPANY = DEMO_COMPANIES[0].id
export const uid = (block: string, n: number) => `0190f0e2-${block.padStart(4, '0').slice(-4)}-7000-8000-${String(n).padStart(12, '0')}`
export const at = (day: number, hour = 9, minute = 0, month = 10) => new Date(Date.UTC(2026, month - 1, day, hour, minute)).toISOString()
export const NOW = at(30, 9, 42)

// ---- roles -------------------------------------------------------------------------------------------------------------------

const template = (key: string): string[] => [...(templateOf(key)?.permissions ?? []), 'home.view']

/**
 * The role cases the design names: the maintenance lead (the `maintenance` template: everything of the plant, signs a
 * machine safe; no money), the production manager (keeps machines, triages, plans jobs; no sign-safe), the floor
 * supervisor (sees and triages; no jobs to plan), the owner (everything, with the machines' cost), read-only (sees,
 * changes nothing) and sales (no plant.view: the page says so).
 */
export const PLANT_ROLES = {
  maintenance: template('maintenance'),
  production: template('production_manager'),
  supervisor: template('floor_supervisor'),
  owner: [...template('maintenance'), 'companies.view', 'users.view', 'roles.view', 'money.cost', 'money.price', 'money.margin'],
  readOnly: [...(templateOf('read_only')?.permissions ?? []), 'home.view'],
  sales: template('sales'),
} as const
export type PlantRole = keyof typeof PLANT_ROLES
export const canAs = (role: PlantRole): PlantCan => plantCan(PLANT_ROLES[role])

/** The Office shell around a page (the role's navigation, this page's place), as the page sees it. */
export function inShell(path: string, page: ReactNode, role: PlantRole = 'maintenance'): ReactNode {
  const shell: OfficeShellViewModel = {
    nav: officeNavFor(permissionCheck([...PLANT_ROLES[role]])),
    path,
    switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: [], site: null, path },
    user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
    tenantTag: DEMO_TAG,
    banners: [],
  }
  return createElement(OfficeShellView, { model: shell }, page)
}

// ---- places ------------------------------------------------------------------------------------------------------------------

export const LINE_1 = { id: uid('2424', 1), code: 'L1', name: 'Linea giacche' }
export const LINE_2 = { id: uid('2424', 2), code: 'L2', name: 'Linea pantaloni' }
export const WC_SEW = { id: uid('2525', 1), code: 'SEW', name: 'Cucitura' }
export const WC_CUT = { id: uid('2525', 2), code: 'CUT', name: 'Taglio' }
export const WC_PRESS = { id: uid('2525', 3), code: 'FIN', name: 'Finissaggio' }
const station = (n: number, code: string, name: string, line: { id: string } | null, centre: { id: string }) => ({ id: uid('2626', n), code, name, lineId: line?.id ?? null, workCentreId: centre.id })
export const STATIONS = {
  sew1: station(1, 'SEW-01', 'Postazione cucitura 1', LINE_1, WC_SEW),
  sew2: station(2, 'SEW-02', 'Postazione cucitura 2', LINE_1, WC_SEW),
  sew3: station(3, 'SEW-03', 'Postazione cucitura 3', LINE_2, WC_SEW),
  cut1: station(4, 'CUT-01', 'Banco taglio 1', null, WC_CUT),
  press1: station(5, 'FIN-01', 'Pressa a caldo', null, WC_PRESS),
}

export const SITE: PlantSite = {
  id: uid('2222', 1),
  companyId: COMPANY,
  code: 'STAB-N',
  name: 'Stabilimento Demo Nord',
  lines: [LINE_1, LINE_2],
  workCentres: [WC_SEW, WC_CUT, WC_PRESS],
  stations: Object.values(STATIONS),
}
export const SITE_SOUTH: PlantSite = { id: uid('2222', 2), companyId: COMPANY, code: 'STAB-S', name: 'Stabilimento Demo Sud', lines: [], workCentres: [WC_SEW], stations: [] }
export const SITES: PlantSite[] = [SITE, SITE_SOUTH]

const placeOf = (entry: { id: string; code: string; name: string }) => ({ id: entry.id, code: entry.code, name: entry.name })

// ---- the group's lists ------------------------------------------------------------------------------------------------------

const cls = (n: number, code: string, labelIt: string, labelEn: string, icon: string): MachineClass => ({ id: uid('3131', n), code, labelIt, labelEn, labelI18n: {}, icon })
export const CLASSES = {
  lockstitch: cls(1, 'LOCKSTITCH', 'Lineare', 'Lockstitch', 'needle'),
  postBed: cls(2, 'POST_BED', 'Colonna', 'Post-bed', 'needle'),
  cuttingTable: cls(3, 'CUTTING_TABLE', 'Tavolo di taglio', 'Cutting table', 'scissors'),
  clickingPress: cls(4, 'CLICKING_PRESS', 'Trancia', 'Clicking press', 'stamp'),
  heatPress: cls(5, 'HEAT_PRESS', 'Pressa a caldo', 'Heat press', 'flame'),
  compressor: cls(6, 'COMPRESSOR', 'Compressore', 'Compressor', 'wind'),
}
export const CLASS_LIST: MachineClass[] = Object.values(CLASSES)

const symptom = (n: number, code: string, classId: string | null, labelIt: string, labelEn: string, icon: string | null, unsafe = false, needsDetail = false): Symptom => ({
  id: uid('3232', n),
  code,
  classId,
  labelIt,
  labelEn,
  labelI18n: {},
  icon,
  colour: null,
  unsafe,
  needsDetail,
  active: true,
})
export const SYMPTOMS = {
  wontStart: symptom(1, 'WONT_START', null, 'Non parte', "Won't start", 'power'),
  noise: symptom(2, 'NOISE', null, 'Rumore', 'Noise', 'volume'),
  oil: symptom(3, 'OIL_LEAK', null, 'Perdita d’olio', 'Oil leak', 'droplet'),
  guard: symptom(4, 'GUARD_MISSING', null, 'Protezione mancante', 'Guard missing', 'shield-off', true),
  other: symptom(5, 'OTHER', null, 'Altro', 'Other', null, false, true),
  thread: symptom(6, 'THREAD_BREAKS', CLASSES.lockstitch.id, 'Il filo si rompe', 'Thread breaks', 'scissors'),
  stitches: symptom(7, 'SKIPPED_STITCHES', CLASSES.lockstitch.id, 'Salta i punti', 'Skipped stitches', 'needle'),
  twoHand: symptom(8, 'TWO_HAND_CONTROL', CLASSES.clickingPress.id, 'Comando a due mani guasto', 'Two-hand control fails', 'hand', true),
  electrical: symptom(9, 'ELECTRICAL_FAULT', null, 'Guasto elettrico', 'Electrical fault', 'zap', true),
}
export const SYMPTOM_LIST: Symptom[] = Object.values(SYMPTOMS)

// ---- people (made up) --------------------------------------------------------------------------------------------------------

export const PEOPLE = {
  me: { kind: 'USER', id: DEMO_USER.id, name: DEMO_USER.displayName } satisfies Person,
  anna: { kind: 'USER', id: uid('3333', 2), name: 'Anna Esempio' } satisfies Person,
  marco: { kind: 'USER', id: uid('3333', 3), name: 'Marco Prova' } satisfies Person,
  /** A floor technician: named only inside one record. */
  luca: { kind: 'WORKER', id: uid('3434', 1), name: 'Luca Demo' } satisfies Person,
  lucaUnnamed: { kind: 'WORKER', id: null, name: null } satisfies Person,
  sew2: { kind: 'STATION', id: STATIONS.sew2.id, name: 'SEW-02 Postazione cucitura 2' } satisfies Person,
  cut1: { kind: 'STATION', id: STATIONS.cut1.id, name: 'CUT-01 Banco taglio 1' } satisfies Person,
}

export const TECHNICIANS: Technician[] = [
  { kind: 'USER', id: DEMO_USER.id, name: DEMO_USER.displayName, me: true },
  { kind: 'USER', id: uid('3333', 2), name: 'Anna Esempio', me: false },
  { kind: 'WORKER', id: uid('3434', 1), name: 'Luca Demo', me: false },
]

// ---- machines ----------------------------------------------------------------------------------------------------------------

const sAt = (key: keyof typeof STATIONS) => {
  const entry = STATIONS[key]
  const line = [LINE_1, LINE_2].find((candidate) => candidate.id === entry.lineId) ?? null
  const centre = [WC_SEW, WC_CUT, WC_PRESS].find((candidate) => candidate.id === entry.workCentreId) ?? null
  return { station: placeOf(entry), line: line ? placeOf(line) : null, workCentre: centre ? placeOf(centre) : null }
}

export function machine(n: number, over: Partial<Machine> = {}): Machine {
  return {
    id: uid('4141', n),
    companyId: COMPANY,
    siteId: SITE.id,
    siteCode: SITE.code,
    assetNumber: `DEMO-SEW-${String(n).padStart(2, '0')}`,
    class: CLASSES.lockstitch,
    make: 'Cuciture Demo',
    modelName: 'CD-8700',
    serialNumber: `SN-D-${String(1000 + n)}`,
    year: 2019,
    ...sAt('sew1'),
    supplier: { id: uid('6060', 4), code: 'MACCHINE-ESEMPIO', name: 'Macchine Esempio S.r.l.' },
    purchaseCost: 185000,
    status: 'RUNNING',
    statusSince: at(2, 8),
    statusReason: null,
    locked: false,
    note: null,
    openRequests: 0,
    openJobs: 0,
    version: 3,
    createdAt: at(1, 8),
    updatedAt: at(28, 10),
    ...over,
  }
}

export const MACHINES = {
  sew1: machine(1),
  sew2: machine(2, { ...sAt('sew2'), status: 'DO_NOT_USE', statusSince: at(30, 9, 12), statusReason: 'Marked unsafe: Guard missing.', locked: true, openRequests: 1, openJobs: 1, version: 7 }),
  sew3: machine(3, { ...sAt('sew3'), status: 'DOWN', statusSince: at(30, 8, 50), statusReason: 'The line stopped: thread breaks.', openRequests: 2, openJobs: 0, version: 5 }),
  sew4: machine(4, { ...sAt('sew3'), class: CLASSES.postBed, modelName: 'CD-PB 4', status: 'UNDER_MAINTENANCE', statusSince: at(29, 14), openJobs: 1 }),
  cutTable: machine(5, { ...sAt('cut1'), assetNumber: 'DEMO-CT-01', class: CLASSES.cuttingTable, make: 'Banchi Demo', modelName: 'BT-30', year: 2020, purchaseCost: 240000 }),
  press: machine(6, { ...sAt('cut1'), assetNumber: 'DEMO-CP-01', class: CLASSES.clickingPress, make: 'Trance Prova', modelName: 'TP-25', year: 2016, purchaseCost: 1260000 }),
  heat: machine(7, { ...sAt('press1'), assetNumber: 'DEMO-HP-01', class: CLASSES.heatPress, make: 'Presse Esempio', modelName: 'PE-H2', year: 2021, purchaseCost: 410000, line: null }),
  compressor: machine(8, { station: null, line: null, workCentre: null, assetNumber: 'DEMO-CMP-01', class: CLASSES.compressor, make: 'Aria Demo', modelName: 'AD-50', serialNumber: null, year: null, purchaseCost: null }),
  retired: machine(9, { assetNumber: 'DEMO-SEW-09', status: 'RETIRED', statusSince: at(10, 16), statusReason: 'Replaced by DEMO-SEW-01.', year: 2008 }),
}
export const MACHINE_LIST: Machine[] = [MACHINES.sew1, MACHINES.sew2, MACHINES.sew3, MACHINES.sew4, MACHINES.cutTable, MACHINES.press, MACHINES.heat, MACHINES.compressor]

export const MACHINE_TILE_COUNTS: MachineTiles = { tiles: { DOWN: 1, DO_NOT_USE: 1, UNDER_MAINTENANCE: 1 }, locked: 1, inUse: 8 }

// ---- requests ----------------------------------------------------------------------------------------------------------------

const brief = (m: Machine) => ({ id: m.id, assetNumber: m.assetNumber, status: m.status, class: m.class })

export function request(n: number, m: Machine, over: Partial<MaintenanceRequest> = {}): MaintenanceRequest {
  return {
    id: uid('5151', n),
    companyId: COMPANY,
    siteId: SITE.id,
    machine: brief(m),
    symptom: SYMPTOMS.thread,
    description: null,
    unsafe: false,
    reportedAt: at(30, 9, 20),
    ageMinutes: 22,
    reportedBy: PEOPLE.sew2,
    station: m.station,
    status: 'NEW',
    acknowledgedAt: null,
    acknowledgedBy: null,
    job: null,
    mergedIntoId: null,
    closedAt: null,
    closedBy: null,
    closeReason: null,
    closeNote: null,
    signedSafe: null,
    locking: false,
    duplicates: 0,
    photos: 0,
    version: 1,
    ...over,
  }
}

export const REQUESTS = {
  unsafe: request(1, MACHINES.sew2, { symptom: SYMPTOMS.guard, description: 'Il carter della cinghia è staccato.', unsafe: true, locking: true, reportedAt: at(30, 9, 12), ageMinutes: 30, photos: 1, status: 'JOB_MADE', job: { id: uid('6161', 1), number: 'MJ-D-0001', status: 'IN_PROGRESS' } }),
  thread: request(2, MACHINES.sew3, { reportedAt: at(30, 8, 50), ageMinutes: 52, duplicates: 1, station: { id: STATIONS.sew3.id, code: 'SEW-03', name: 'Postazione cucitura 3' } }),
  threadAgain: request(3, MACHINES.sew3, { symptom: SYMPTOMS.stitches, reportedAt: at(30, 9, 28), ageMinutes: 14, duplicates: 1, reportedBy: PEOPLE.anna, station: null }),
  noise: request(4, MACHINES.heat, { symptom: SYMPTOMS.noise, reportedAt: at(30, 9, 35), ageMinutes: 7, status: 'ACKNOWLEDGED', acknowledgedAt: at(30, 9, 38), acknowledgedBy: PEOPLE.me, reportedBy: PEOPLE.cut1 }),
  oil: request(5, MACHINES.press, { symptom: SYMPTOMS.oil, description: 'Macchia d’olio sotto il piano.', reportedAt: at(29, 15, 5), ageMinutes: 1117 }),
  closed: request(6, MACHINES.sew1, { symptom: SYMPTOMS.wontStart, reportedAt: at(28, 11), ageMinutes: 2800, status: 'CLOSED', closedAt: at(28, 11, 20), closedBy: PEOPLE.anna, closeReason: 'SOLVED_BY_OPERATOR', closeNote: null }),
}
export const OPEN_QUEUE: MaintenanceRequest[] = [REQUESTS.unsafe, REQUESTS.oil, REQUESTS.thread, REQUESTS.threadAgain, REQUESTS.noise].filter((row) => row.status === 'NEW' || row.status === 'ACKNOWLEDGED' || row.locking)
export const REQUEST_TILE_COUNTS: RequestTiles = { NEW: { count: 3, oldestMinutes: 1117 }, UNSAFE: 1, DOWN: 1, WAITING: 2, DUPLICATES: 1 }

// ---- jobs --------------------------------------------------------------------------------------------------------------------

const jobMachine = (m: Machine) => ({ id: m.id, assetNumber: m.assetNumber, status: m.status, locked: m.locked, class: m.class, station: m.station, line: m.line })

export function job(n: number, m: Machine, over: Partial<MaintenanceJob> = {}): MaintenanceJob {
  return {
    id: uid('6161', n),
    companyId: COMPANY,
    siteId: SITE.id,
    number: `MJ-D-${String(n).padStart(4, '0')}`,
    machine: jobMachine(m),
    type: 'CORRECTIVE',
    source: 'REQUEST',
    problem: 'Il filo si rompe: tensione da verificare.',
    symptom: SYMPTOMS.thread,
    priority: 'P2',
    assignee: PEOPLE.anna,
    ownership: 'OTHER',
    dueAt: at(31, 16),
    overdue: false,
    status: 'NEW',
    startedAt: null,
    handedBack: null,
    closedAt: null,
    closedBy: null,
    cancelledAt: null,
    cancelReason: null,
    requestIds: [],
    ageMinutes: 60,
    open: true,
    createdAt: at(30, 8, 40),
    createdBy: PEOPLE.me,
    version: 2,
    ...over,
  }
}

export const JOBS = {
  safety: job(1, MACHINES.sew2, {
    type: 'SAFETY',
    problem: 'Protezione mancante: il carter della cinghia è staccato.',
    symptom: SYMPTOMS.guard,
    priority: 'P1',
    assignee: PEOPLE.lucaUnnamed,
    status: 'IN_PROGRESS',
    startedAt: at(30, 9, 30),
    requestIds: [REQUESTS.unsafe.id],
    dueAt: at(30, 12),
    ageMinutes: 30,
    createdAt: at(30, 9, 14),
  }),
  thread: job(2, MACHINES.sew4, { status: 'WAITING_PARTS', assignee: PEOPLE.me, ownership: 'MINE', startedAt: at(29, 14), problem: 'Crochet usurato: ricambio ordinato.', dueAt: at(29, 18), overdue: true, ageMinutes: 1200 }),
  planned: job(3, MACHINES.press, { type: 'INSPECTION', source: 'STATUTORY_CHECK', problem: 'Verifica periodica del comando a due mani.', symptom: null, priority: 'P3', status: 'PLANNED', assignee: null, ownership: 'NOBODY', dueAt: at(5, 9, 0, 11), ageMinutes: 4300 }),
  fresh: job(4, MACHINES.heat, { problem: 'Rumore al cilindro superiore.', symptom: SYMPTOMS.noise, assignee: null, ownership: 'NOBODY', dueAt: null, ageMinutes: 5, createdAt: at(30, 9, 37), source: 'MANUAL' }),
  handedBack: job(5, MACHINES.cutTable, {
    type: 'PREVENTIVE',
    source: 'MANUAL',
    problem: 'Pulizia e regolazione del piano aspirato.',
    symptom: null,
    priority: 'P3',
    status: 'HANDED_BACK',
    startedAt: at(29, 8),
    handedBack: { at: at(29, 11), by: PEOPLE.anna, workDone: 'Piano pulito, filtri cambiati.', machineAfter: 'RUNNING' },
    ageMinutes: 1700,
  }),
  closed: job(6, MACHINES.sew1, { status: 'CLOSED', open: false, closedAt: at(27, 17), closedBy: PEOPLE.me, startedAt: at(27, 14), handedBack: { at: at(27, 16), by: PEOPLE.anna, workDone: 'Tensione regolata.', machineAfter: 'RUNNING' }, ageMinutes: 4300 }),
}
export const JOB_LIST: MaintenanceJob[] = [JOBS.fresh, JOBS.safety, JOBS.thread, JOBS.planned, JOBS.handedBack]
export const JOB_TILE_COUNTS: JobTiles = { OPEN: 5, OVERDUE: 1, UNSAFE: 1, WAITING_PARTS: 1, CLOSED_THIS_WEEK: 3 }

const briefOf = (entry: MaintenanceJob): JobBrief => ({ id: entry.id, number: entry.number, type: entry.type, status: entry.status, problem: entry.problem, createdAt: entry.createdAt, closedAt: entry.closedAt })

export function card(m: Machine, over: Partial<MachineCard> = {}): MachineCard {
  return { machine: m, openJob: null, lastJobs: [briefOf(JOBS.closed)], requestsIn30Days: 1, repeatFailure: false, ...over }
}

export const CARDS = {
  sew2: card(MACHINES.sew2, { openJob: { id: JOBS.safety.id, number: JOBS.safety.number, status: JOBS.safety.status }, lastJobs: [briefOf(JOBS.safety), briefOf(JOBS.closed)], requestsIn30Days: 1 }),
  sew3: card(MACHINES.sew3, { requestsIn30Days: 3, repeatFailure: true, lastJobs: [briefOf(JOBS.closed)] }),
  heat: card(MACHINES.heat, { openJob: { id: JOBS.fresh.id, number: JOBS.fresh.number, status: JOBS.fresh.status } }),
}
