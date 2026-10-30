import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { MachineRecord } from '../../_shared/api'
import { canAs, card, CARDS, CLASS_LIST, inShell, JOBS, MACHINES, PREFIX, REQUESTS, SITES, type PlantRole } from '../../_shared/fixtures'
import type { MachineRecordModel, MachineTab } from '../view-model'
import { MachineRecordView } from './view/MachineRecordView'

/**
 * SCR-150-record — a machine (Plant › Machines & tools › a machine) with made-up data only: Overview (the facts, the Now
 * panel with its open job and requests; the explicit edit; the cost only with the cost grain), a machine locked as unsafe,
 * a stopped machine with the third-failure hint, a retired one, Maintenance history, Retire with its reason, and the
 * page's states.
 */

interface MachineCase {
  role: PlantRole
  record: MachineRecordModel
}

const SEW2: MachineRecord = { card: CARDS.sew2, openRequests: [], history: [JOBS.safety, JOBS.closed], canManage: true, canReport: true }
const SEW3: MachineRecord = { card: CARDS.sew3, openRequests: [REQUESTS.thread, REQUESTS.threadAgain], history: [JOBS.closed], canManage: true, canReport: true }
const SEW1: MachineRecord = { card: card(MACHINES.sew1), openRequests: [], history: [JOBS.closed], canManage: true, canReport: true }
const RETIRED: MachineRecord = { card: card(MACHINES.retired), openRequests: [], history: [], canManage: true, canReport: false }

function record(role: PlantRole, tab: MachineTab, value: MachineRecord | null, over: Partial<MachineRecordModel> = {}): MachineCase {
  return {
    role,
    record: {
      prefix: PREFIX,
      can: canAs(role),
      tab,
      loaded: value ? { status: 'ready', value } : { status: 'loading' },
      timeZone: 'Europe/Rome',
      live: 'live',
      asOf: '2026-10-30T09:42:00.000Z',
      sites: SITES,
      classes: CLASS_LIST,
      edit: null,
      suppliers: null,
      busy: false,
      field: null,
      retire: null,
      notice: null,
      ...over,
    },
  }
}

function MachineDesign({ model }: { model: MachineCase }) {
  const id = model.record.loaded.status === 'ready' ? model.record.loaded.value.card.machine.id : 'x'
  return inShell(`/plant/machines/${id}`, createElement(MachineRecordView, { model: model.record }), model.role)
}

const edit = { siteId: MACHINES.sew1.siteId, assetNumber: MACHINES.sew1.assetNumber, classId: MACHINES.sew1.class.id, make: 'Cuciture Demo', modelName: 'CD-8700', serialNumber: 'SN-D-1001', year: '2019', stationId: SITES[0]!.stations[0]!.id, workCentreId: SITES[0]!.workCentres[0]!.id, supplier: null, cost: '1850,00', note: '' }

export const designScreen = defineDesignScreen<MachineCase>({
  screen: 'SCR-150-record',
  title: 'Machine (Overview, Maintenance history)',
  view: MachineDesign,
  cases: [
    { id: 'overview', label: 'Overview: a running machine (maintenance lead, no money)', model: record('maintenance', 'overview', SEW1) },
    { id: 'owner-cost', label: 'Overview with the purchase cost (owner)', model: record('owner', 'overview', SEW1) },
    { id: 'locked', label: 'Locked as unsafe: its open job, waiting for the sign-safe', model: record('maintenance', 'overview', SEW2) },
    { id: 'down', label: 'Down with two open requests and the third-failure hint', model: record('maintenance', 'overview', SEW3) },
    { id: 'edit', label: 'The explicit edit of the facts', model: record('owner', 'overview', SEW1, { edit }) },
    { id: 'edit-refused', label: 'The edit refused at a field (station of another site)', model: record('maintenance', 'overview', SEW1, { edit, field: 'stationId', notice: { tone: 'danger', words: { key: 'cell.refusedMachine', params: { machine: MACHINES.sew1.assetNumber } }, detail: { key: 'problem.field.stationId' } } }) },
    { id: 'history', label: 'Maintenance history', model: record('maintenance', 'history', SEW2) },
    { id: 'history-empty', label: 'No history yet', model: record('maintenance', 'history', { ...SEW1, history: [] }) },
    { id: 'retire', label: 'Retire with its reason', model: record('maintenance', 'overview', SEW1, { retire: { reason: '', busy: false, problem: null } }) },
    { id: 'retired', label: 'A retired machine: kept for its history, its tag reports nothing', model: record('maintenance', 'overview', RETIRED) },
    { id: 'supervisor', label: 'Floor supervisor: reads; edit and New job held', model: record('supervisor', 'overview', { ...SEW1, canManage: false }) },
    { id: 'loading', label: 'Loading', model: record('maintenance', 'overview', null) },
    { id: 'not-found', label: 'Not found', model: record('maintenance', 'overview', null, { loaded: { status: 'notFound' } }) },
    { id: 'error', label: "Couldn't be read", model: record('maintenance', 'overview', null, { loaded: { status: 'error', problem: 'problem.unavailable' } }) },
    { id: 'sales', label: 'Sales: no plant.view', model: record('sales', 'overview', null, { loaded: { status: 'forbidden' } }) },
  ],
})
