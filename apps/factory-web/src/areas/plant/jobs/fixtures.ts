import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { canAs, inShell, JOB_LIST, JOB_TILE_COUNTS, JOBS, MACHINES, NOW, PREFIX, SITE, SITES, TECHNICIANS, type PlantRole } from '../_shared/fixtures'
import type { JobsDialog, JobsListModel } from './view-model'
import { JobsView } from './view/JobsView'

/**
 * SCR-149 — Maintenance jobs (Plant › Maintenance) with made-up data only: the open jobs as a list (inline priority, due
 * and technician; one cell saving, one saved, one refused) and as a board by state (a hand-back opens the job's close
 * form; Closed only after it), each tile pressed, New job (the machine found, its site's technicians), Assign jobs (old →
 * new per job), and the page's states. Roles: the maintenance lead (plans and works), the production manager (plans,
 * works no job), the floor supervisor (sees; plans nothing: New job held), read-only and sales (no plant.view).
 */

interface JobsCase {
  role: PlantRole
  list: JobsListModel
}

const sites = SITES.map((site) => ({ id: site.id, code: site.code, name: site.name }))

function list(role: PlantRole, over: Partial<JobsListModel> = {}): JobsCase {
  return {
    role,
    list: {
      prefix: PREFIX,
      can: canAs(role),
      address: { view: 'open', siteId: null, machineId: null, mode: 'list' },
      machine: null,
      sites,
      rows: { items: JOB_LIST, more: false, problem: null },
      tiles: JOB_TILE_COUNTS,
      asOf: NOW,
      live: 'live',
      updates: 0,
      timeZone: 'Europe/Rome',
      now: NOW,
      technicians: { [SITE.id]: { technicians: TECHNICIANS, floorListed: true, problem: null } },
      cells: {},
      dialog: null,
      notice: null,
      moving: null,
      ...over,
    },
  }
}

const newJob = (over: Partial<Extract<JobsDialog, { kind: 'new' }>> = {}): JobsDialog => ({
  kind: 'new',
  draft: { query: '', machine: null, type: 'CORRECTIVE', problem: '', priority: 'P2', source: 'MANUAL', assignee: '', due: '', plan: false },
  found: null,
  searching: false,
  busy: false,
  problem: null,
  ...over,
})

function JobsDesign({ model }: { model: JobsCase }) {
  return inShell('/plant/jobs', createElement(JobsView, { model: model.list }), model.role)
}

export const designScreen = defineDesignScreen<JobsCase>({
  screen: 'SCR-149',
  title: 'Maintenance jobs (list and board)',
  view: JobsDesign,
  cases: [
    { id: 'maintenance', label: 'Maintenance lead: open jobs, inline priority, due and technician', model: list('maintenance'), note: 'c makes a job; b switches to the board; a number opens the job.' },
    {
      id: 'cells',
      label: 'Inline edits: one saving, one saved, one refused (changed by someone else)',
      model: list('maintenance', { cells: { [`${JOBS.fresh.id}:priority`]: { state: 'saving' }, [`${JOBS.safety.id}:due`]: { state: 'saved' }, [`${JOBS.planned.id}:assignee`]: { state: 'failed', words: { key: 'problem.conflict' } } }, notice: { tone: 'danger', words: { key: 'cell.refused', params: { number: JOBS.planned.number } }, detail: { key: 'problem.conflict' } } }),
    },
    { id: 'board', label: 'Board by state: New, Planned, In progress, Waiting parts, Hand-back, Closed', model: list('maintenance', { address: { view: 'open', siteId: null, machineId: null, mode: 'board' }, rows: { items: [...JOB_LIST, JOBS.closed], more: false, problem: null } }), note: 'Drag, or Space / M then ← → and Enter; a drop on Hand-back opens the close form.' },
    { id: 'board-read-only', label: 'Board, read-only: nothing moves (said why)', model: list('readOnly', { address: { view: 'open', siteId: null, machineId: null, mode: 'board' } }) },
    { id: 'tile-overdue', label: 'Tile pressed: overdue', model: list('maintenance', { address: { view: 'overdue', siteId: null, machineId: null, mode: 'list' }, rows: { items: [JOBS.thread], more: false, problem: null } }) },
    { id: 'mine', label: 'Rows ▾ My jobs', model: list('maintenance', { address: { view: 'mine', siteId: null, machineId: null, mode: 'list' }, rows: { items: [JOBS.thread], more: false, problem: null } }) },
    { id: 'this-machine', label: 'One machine (from its record): every job of it', model: list('maintenance', { address: { view: 'all', siteId: SITE.id, machineId: MACHINES.sew1.id, mode: 'list' }, machine: { id: MACHINES.sew1.id, assetNumber: MACHINES.sew1.assetNumber }, rows: { items: [JOBS.closed], more: false, problem: null } }) },
    { id: 'selected', label: 'Three jobs selected: Assign 3, Export 3 (CSV)', model: list('maintenance', { selected: [JOBS.fresh.id, JOBS.planned.id, JOBS.handedBack.id] }) },
    { id: 'assign', label: 'Assign jobs: the technician old → new per job', model: list('maintenance', { dialog: { kind: 'assign', jobs: [JOBS.fresh, JOBS.planned, JOBS.thread], assignee: `USER:${TECHNICIANS[1]!.id}`, busy: false, problem: null } }) },
    { id: 'new-job', label: 'New job: find the machine (type or scan its asset number)', model: list('maintenance', { dialog: newJob() }) },
    {
      id: 'new-job-filled',
      label: 'New job: a statutory check on the clicking press, planned, a floor technician',
      model: list('maintenance', { dialog: newJob({ draft: { query: 'CP-01', machine: MACHINES.press, type: 'INSPECTION', problem: 'Verifica periodica del comando a due mani.', priority: 'P2', source: 'STATUTORY_CHECK', assignee: `WORKER:${TECHNICIANS[2]!.id}`, due: '2026-11-05T09:00', plan: true }, found: [MACHINES.press] }) }),
    },
    { id: 'new-job-refused', label: 'New job refused in words (the machine is retired)', model: list('maintenance', { dialog: newJob({ draft: { query: 'SEW-09', machine: MACHINES.retired, type: 'CORRECTIVE', problem: 'Controllo', priority: 'P3', source: 'MANUAL', assignee: '', due: '', plan: false }, found: [MACHINES.retired], problem: { key: 'refusal.RETIRED' } }) }) },
    { id: 'production', label: 'Production manager: plans and assigns; works no job', model: list('production') },
    { id: 'supervisor', label: 'Floor supervisor: sees the jobs; New job held with the reason', model: list('supervisor') },
    { id: 'read-only', label: 'Read-only: no inline edits, New job held', model: list('readOnly') },
    { id: 'updates', label: 'Live changes waiting behind "3 updates · Show"', model: list('maintenance', { updates: 3 }) },
    { id: 'loading', label: 'Loading', model: list('maintenance', { rows: { items: null, more: false, problem: null }, tiles: null, asOf: null }) },
    { id: 'error', label: "The jobs couldn't be read", model: list('maintenance', { rows: { items: null, more: false, problem: 'problem.unavailable' }, tiles: null }) },
    { id: 'empty', label: 'No jobs yet', model: list('maintenance', { rows: { items: [], more: false, problem: null }, tiles: { OPEN: 0, OVERDUE: 0, UNSAFE: 0, WAITING_PARTS: 0, CLOSED_THIS_WEEK: 0 } }) },
    { id: 'no-match', label: 'Nothing matches the row', model: list('maintenance', { address: { view: 'waiting', siteId: null, machineId: null, mode: 'list' }, rows: { items: [], more: false, problem: null } }) },
    { id: 'keys', label: 'The keys (footer icon, ?)', model: list('maintenance', { helpOpen: true }) },
    { id: 'sales', label: 'Sales: no plant.view (the page says so)', model: list('sales') },
  ],
})
