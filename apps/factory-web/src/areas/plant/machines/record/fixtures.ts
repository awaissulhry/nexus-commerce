import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { MachineRecord } from '../../_shared/api'
import { canAs, card, CARDS, CLASS_LIST, inShell, JOBS, MACHINES, PREFIX, REQUESTS, SITES, type PlantRole } from '../../_shared/fixtures'
import { STEP_UP_CLOSED } from '../../_shared/parts'
import { DOCUMENTS, FACTS, HISTORY, recordDepth, tagJob, tagsState } from '../depth/fixtures'
import type { MachineRecordModel, MachineTab, RecordDepth } from '../view-model'
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
      depth: recordDepth({ facts: value ? (FACTS[value.card.machine.id] ?? null) : null }),
      ...over,
    },
  }
}

/** B-W2b-136: a record with its depth changed. */
const deep = (role: PlantRole, tab: MachineTab, value: MachineRecord | null, depth: Partial<RecordDepth>, over: Partial<MachineRecordModel> = {}): MachineCase =>
  record(role, tab, value, { ...over, depth: recordDepth({ facts: value ? (FACTS[value.card.machine.id] ?? null) : null, ...depth }) })
const docs = (over: Partial<RecordDepth['documents']>): RecordDepth['documents'] => ({ ...recordDepth().documents, ...over })

function MachineDesign({ model }: { model: MachineCase }) {
  const id = model.record.loaded.status === 'ready' ? model.record.loaded.value.card.machine.id : 'x'
  return inShell(`/plant/machines/${id}`, createElement(MachineRecordView, { model: model.record }), model.role)
}

const edit = { siteId: MACHINES.sew1.siteId, assetNumber: MACHINES.sew1.assetNumber, classId: MACHINES.sew1.class.id, make: 'Cuciture Demo', modelName: 'CD-8700', serialNumber: 'SN-D-1001', year: '2019', stationId: SITES[0]!.stations[0]!.id, workCentreId: SITES[0]!.workCentres[0]!.id, supplier: null, cost: '1850,00', note: '' }

export const designScreen = defineDesignScreen<MachineCase>({
  screen: 'SCR-150-record',
  title: 'Machine (Overview, Documents & CE, Maintenance history, Status & downtime, Tag)',
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
    // B-W2b-136: Documents & CE, Status & downtime, Tag, Change status.
    { id: 'w2a-only', label: 'The W2a record without the depth (as before B-W2b-136)', model: record('maintenance', 'overview', SEW1, { depth: undefined }) },
    { id: 'now-check', label: 'Now panel: the next statutory check overdue, CE on file', model: record('maintenance', 'overview', { ...SEW1, card: card(MACHINES.press) }) },
    { id: 'docs', label: 'Documents & CE: CE declaration, manuals, photos, the rest; on the tablets; the scan', model: record('maintenance', 'docs', SEW1), note: 'art. 71 c.4: the manuals at hand where the machine works.' },
    { id: 'docs-no-ce', label: 'Documents & CE: no CE declaration on file (flagged first)', model: deep('maintenance', 'docs', SEW1, { documents: docs({ loaded: { status: 'ready', value: { documents: DOCUMENTS.filter((row) => row.group !== 'MACHINE_CE'), ceOnFile: false, canManage: true } } }) }) },
    { id: 'docs-empty', label: 'Documents & CE: nothing yet ("Upload the CE declaration first")', model: deep('maintenance', 'docs', SEW1, { documents: docs({ loaded: { status: 'ready', value: { documents: [], ceOnFile: false, canManage: true } } }) }) },
    { id: 'docs-uploading', label: 'Documents & CE: a manual uploading', model: deep('maintenance', 'docs', SEW1, { documents: docs({ upload: { group: 'MANUAL', onTablets: true, busy: true, problem: null, done: null } }) }) },
    { id: 'docs-uploaded', label: 'Documents & CE: uploaded', model: deep('maintenance', 'docs', SEW1, { documents: docs({ upload: { group: 'MACHINE_CE', onTablets: true, busy: false, problem: null, done: 'dichiarazione-ce.pdf' } }) }) },
    { id: 'docs-refused', label: 'Documents & CE: a photo refused as a manual (in words)', model: deep('maintenance', 'docs', SEW1, { documents: docs({ upload: { group: 'MANUAL', onTablets: true, busy: false, problem: { key: 'depth:docs.held.manualPdf' }, done: null } }) }) },
    { id: 'docs-viewer', label: 'Documents & CE: a file open for a look (reading)', model: deep('maintenance', 'docs', SEW1, { documents: docs({ viewer: { document: DOCUMENTS[0]!, bytes: null, url: null, problem: null } }) }) },
    { id: 'docs-remove', label: 'Documents & CE: Remove asks the reason', model: deep('maintenance', 'docs', SEW1, { documents: docs({ remove: { document: DOCUMENTS[2]!, reason: '', busy: false, problem: null } }) }) },
    { id: 'docs-read-only', label: 'Documents & CE read-only (floor supervisor): upload and remove held', model: deep('supervisor', 'docs', { ...SEW1, canManage: false }, { documents: docs({ loaded: { status: 'ready', value: { documents: DOCUMENTS, ceOnFile: true, canManage: false } } }) }) },
    { id: 'docs-loading', label: 'Documents & CE loading', model: deep('maintenance', 'docs', SEW1, { documents: docs({ loaded: { status: 'loading' } }) }) },
    { id: 'docs-error', label: "Documents & CE couldn't be read", model: deep('maintenance', 'docs', SEW1, { documents: docs({ loaded: { status: 'error', problem: 'problem.unavailable' } }) }) },
    { id: 'status', label: 'Status & downtime: the week day by day, the time per status, the changes with reasons', model: record('maintenance', 'status', SEW1) },
    { id: 'status-loading', label: 'Status & downtime loading', model: deep('maintenance', 'status', SEW1, { history: { loaded: { status: 'loading' }, week: '2026-10-26' } }) },
    { id: 'status-error', label: "Status & downtime couldn't be read", model: deep('maintenance', 'status', SEW1, { history: { loaded: { status: 'error', problem: 'problem.unavailable' }, week: '2026-10-26' } }) },
    { id: 'status-quiet', label: 'Status & downtime: no change this week', model: deep('maintenance', 'status', SEW1, { history: { loaded: { status: 'ready', value: { ...HISTORY, events: [], latest: [] } }, week: '2026-10-26' } }) },
    { id: 'status-locked', label: 'Status & downtime: locked as unsafe, Change status held (H1)', model: record('maintenance', 'status', SEW2) },
    { id: 'change', label: 'Change status: down, with the reason', model: deep('maintenance', 'overview', SEW1, { status: { draft: { to: 'DOWN', reason: 'Motore surriscaldato' }, busy: false, problem: null } }) },
    { id: 'change-dnu', label: 'Change status to do-not-use: a reason, and only a technician releases it', model: deep('production', 'overview', SEW1, { status: { draft: { to: 'DO_NOT_USE', reason: '' }, busy: false, problem: null } }) },
    {
      id: 'change-release',
      label: 'Release from do-not-use: a technician, with a fresh code',
      model: deep('maintenance', 'overview', { ...SEW1, card: card({ ...MACHINES.sew1, status: 'DO_NOT_USE', statusReason: 'Protezione incrinata' }) }, { status: { draft: { to: 'RUNNING', reason: 'Ricambio montato' }, busy: false, problem: null } }),
    },
    {
      id: 'change-release-held',
      label: 'Release held without plant.signSafe (production manager)',
      model: deep('production', 'overview', { ...SEW1, card: card({ ...MACHINES.sew1, status: 'DO_NOT_USE', statusReason: 'Protezione incrinata' }) }, { status: { draft: { to: 'RUNNING', reason: 'Ricambio montato' }, busy: false, problem: null } }),
    },
    {
      id: 'change-stepup',
      label: 'The fresh code of the release',
      model: deep('maintenance', 'overview', { ...SEW1, card: card({ ...MACHINES.sew1, status: 'DO_NOT_USE', statusReason: 'Protezione incrinata' }) }, { status: { draft: { to: 'RUNNING', reason: 'Ricambio montato' }, busy: true, problem: null }, stepUp: { ...STEP_UP_CLOSED, open: true, sentence: 'stepUp.release' } }),
    },
    { id: 'change-refused', label: 'Change status refused: locked as unsafe (in words)', model: deep('maintenance', 'overview', SEW2, { status: { draft: { to: 'UNDER_MAINTENANCE', reason: 'Prova' }, busy: false, problem: { key: 'depth:refusal.LOCKED_UNSAFE' } } }) },
    { id: 'tag', label: 'Tag: the tag to scale with its QR, printed on a day', model: record('maintenance', 'tag', SEW1) },
    { id: 'tag-failed', label: 'Tag: the last print failed (Retry)', model: deep('maintenance', 'tag', SEW1, { tagJob: { status: 'ready', value: tagJob(MACHINES.sew1.id, 'FAILED') } }) },
    { id: 'tag-never', label: 'Tag: never sent to a label printer', model: deep('maintenance', 'tag', SEW1, { tagJob: { status: 'ready', value: null } }) },
    { id: 'tag-print', label: 'Tag: Print QR tags for this machine', model: deep('maintenance', 'tag', SEW1, { tags: tagsState({ machines: [tagsState().machines[0]!] }) }) },
    { id: 'tag-retired', label: 'Tag of a retired machine: nothing to print', model: deep('maintenance', 'tag', RETIRED, { tagJob: { status: 'ready', value: null } }) },
    { id: 'tag-no-right', label: 'Tag: print held without print.labels (production manager)', model: deep('production', 'tag', SEW1, { canPrint: false }) },
  ],
})
