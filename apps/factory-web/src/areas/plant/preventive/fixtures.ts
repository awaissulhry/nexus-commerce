import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import type { OfficeScope } from '../../../shell/scope/scope-model'
import {
  BODIES,
  calendarAnswer,
  CHIPS,
  COUNTS,
  ENDED_PLAN,
  FORKLIFT,
  GUARDS,
  GUARDS_PLAN,
  inPreventiveShell,
  LIFTING_PLAN,
  MACHINES,
  NOW,
  OWNERS,
  PATH,
  planRecord,
  PLANS,
  PREFIX,
  PREVENTIVE_ROLES_DEMO,
  PRESS,
  RESULT_IDS,
  resultRecord,
  RESULTS,
  SCOPE_ALL,
  SCOPE_ONE,
  TODAY,
  TYPES,
  VESSEL_PLAN,
  type PreventiveRoleDemo,
} from './_demo/fixtures'
import { chipKey, EMPTY_ADDRESS, EMPTY_PLAN, newResultDraft, preventiveCan, withOutcome, withType, type PreventiveAddress } from './model'
import type { MoveState, PlanNewState, PreventivePageModel, ResultNewState, ResultOpenState } from './view-model'
import { PreventivePageView } from './view/PreventivePageView'

/**
 * SCR-266 — Plant › Maintenance › Preventive & statutory checks (B-W2b-142; design plant.preventive). Made-up data only
 * (./_demo): an invented company with two sites, invented machines, an invented outside body and invented people. Roles
 * from factory-domain's templates: maintenance and the production manager keep the checks; the safety officer and
 * read-only look; a role that keeps the checks only sees the job and the lock held with their rights; sales has no
 * plant.view. The labels and notes are English (the design index only); the screen's words come from the catalogues.
 */

interface PreventiveCase {
  role: PreventiveRoleDemo
  model: PreventivePageModel
}

const ready = <T,>(value: T) => ({ status: 'ready' as const, value })
const loading = { status: 'loading' as const }
const failed = { status: 'error' as const, problem: 'problem.read' }
const site = PLANS.filter((plan) => plan.site.id === SCOPE_ONE.site?.id)
const register = RESULTS.filter((result) => result.site.id === SCOPE_ONE.site?.id)

function base(role: PreventiveRoleDemo, over: Partial<PreventivePageModel> = {}, address: Partial<PreventiveAddress> = {}, scope: OfficeScope = SCOPE_ONE): PreventiveCase {
  const can = preventiveCan(PREVENTIVE_ROLES_DEMO[role])
  return {
    role,
    model: {
      prefix: PREFIX,
      path: PATH,
      can,
      scope,
      address: { ...EMPTY_ADDRESS, ...address },
      today: TODAY,
      month: address.month ?? TODAY.slice(0, 7),
      counts: ready(COUNTS),
      calendar: ready(calendarAnswer({ canManage: can.manage }, scope)),
      calendarReading: false,
      plans: ready({ rows: scope.allSites ? PLANS : site, next: null, more: false }),
      plansMore: false,
      register: ready({ rows: scope.allSites ? RESULTS : register, next: null, more: false }),
      registerMore: false,
      readAt: NOW,
      notice: null,
      planNew: null,
      resultNew: null,
      planOpen: null,
      resultOpen: null,
      move: null,
      ...over,
    },
  }
}

const planNew = (over: Partial<PlanNewState> = {}): PlanNewState => ({
  draft: { ...withType({ ...EMPTY_PLAN, machineId: PRESS.id }, GUARDS), firstDueOn: '2026-11-30', reminderDays: '7', ownerId: OWNERS[0]!.id },
  machines: ready(MACHINES.filter((machine) => machine.siteId === SCOPE_ONE.site?.id)),
  types: ready(TYPES.filter((type) => type.machineClass === null || type.machineClass.id === PRESS.class.id)),
  bodies: ready(BODIES),
  owners: ready(OWNERS),
  busy: false,
  problem: null,
  ...over,
})

const resultNew = (over: Partial<ResultNewState> = {}): ResultNewState => ({
  draft: { ...withOutcome(newResultDraft(TODAY, LIFTING_PLAN), 'FAILED'), remarks: 'Fune di sollevamento lesionata (dato di esempio).', lock: true },
  plan: ready({ ...LIFTING_PLAN, machine: { ...LIFTING_PLAN.machine, locked: false } }),
  corrects: null,
  machines: null,
  types: null,
  bodies: ready(BODIES),
  busy: false,
  uploading: false,
  problem: null,
  ...over,
})

const resultOpen = (over: Partial<ResultOpenState> = {}): ResultOpenState => ({ id: RESULT_IDS.lifting, read: ready(resultRecord()), step: 'view', lockNote: '', busy: false, uploading: false, problem: null, saved: null, ...over })

const move = (over: Partial<MoveState> = {}): MoveState => ({ plans: ready([VESSEL_PLAN]), draft: { nextDueOn: '2026-11-27', reason: '' }, busy: false, problem: null, bulk: false, ...over })

/** The due chips a Move N chooses in the List case. */
const DUE_CHIP_KEYS = CHIPS.filter((chip) => chip.kind === 'DUE' && chip.site.id === SCOPE_ONE.site?.id).map((chip) => chipKey(chip))

function PreventiveDesign({ model }: { model: PreventiveCase }) {
  return inPreventiveShell('/plant/preventive', createElement(PreventivePageView, { model: model.model }), model.role, model.model.scope)
}

const reportFile = (name: string) => [{ id: 'f0190f0e-0000-7000-8000-000000000099', originalName: name, contentType: 'application/pdf', sizeBytes: 201_000, availableAt: NOW }]

export const designScreen = defineDesignScreen<PreventiveCase>({
  screen: 'SCR-266',
  title: 'Preventive & statutory checks (Plant › Maintenance)',
  view: PreventiveDesign,
  cases: [
    {
      id: 'month',
      label: 'Maintenance: the month',
      model: base('maintenance'),
      note: 'Tiles (overdue, due in 30 days, reports missing) · the month with each day as its worst state and today’s agenda on the right · Plans · Check register. Keys: n new plan, r record a result, [ / ] the month. A due check drags onto another day (Move a check asks why).',
    },
    { id: 'month-day', label: 'Another day: the overdue press check', model: base('maintenance', {}, { day: '2026-10-28' }), note: 'The press guards check is overdue: it drags onto another day, or opens its plan with Enter.' },
    { id: 'month-next', label: 'Next month: later checks by the interval', model: base('maintenance', { calendar: ready(calendarAnswer({ from: '2026-11-01', to: '2027-01-31' })) }, { month: '2026-12' }) },
    { id: 'list', label: 'Calendar as a List', model: base('maintenance', {}, { view: 'list' }), note: 'Day · Check (with its law) · Machine · Outside body · What. At phone width (390) the list becomes cards.' },
    {
      id: 'list-selected',
      label: 'List: due checks chosen, Move N',
      model: base('maintenance', { chipSelected: DUE_CHIP_KEYS }, { view: 'list' }),
      note: 'Only a check’s next due date may be chosen; a later check or a check done says why on its box.',
    },
    { id: 'plans-overdue', label: 'Tile “Checks overdue”: the plans filtered', model: base('maintenance', { plans: ready({ rows: [GUARDS_PLAN], next: null, more: false }) }, { due: 'OVERDUE' }), note: 'A tile is a filter of Plans (?due=OVERDUE); the chip clears it.' },
    { id: 'plans-ended', label: 'Plans: Ended', model: base('maintenance', { plans: ready({ rows: [ENDED_PLAN], next: null, more: false }) }, { ended: true }), note: 'An ended plan may not be chosen; it says why.' },
    { id: 'plans-selected', label: 'Plans: rows chosen, Move N', model: base('maintenance', { selected: [GUARDS_PLAN.id, VESSEL_PLAN.id] }) },
    { id: 'plans-more', label: 'Plans: more to read', model: base('maintenance', { plans: ready({ rows: PLANS.slice(0, 3), next: '2027-01-15|x', more: false }) }), note: 'The footer’s Show more reads the next page.' },
    {
      id: 'register-missing',
      label: 'Tile “Reports missing”: the register filtered',
      model: base('maintenance', { register: ready({ rows: RESULTS.filter((result) => result.inForce && !result.reportOnFile), next: null, more: false }) }, { missing: true }),
    },
    { id: 'register-selected', label: 'Register: rows chosen, Print N / Export N', model: base('maintenance', { registerSelected: [RESULT_IDS.lifting, RESULT_IDS.guards] }), note: 'Print N opens the register print with only those results; Export N appears for a role that may export.' },
    { id: 'all-sites', label: 'All sites: Site column and chip', model: base('maintenance', {}, {}, SCOPE_ALL), note: '"All sites" in the top bar: a Site column in each list, each agenda item names its site.' },
    { id: 'all-sites-list', label: 'All sites: the List', model: base('maintenance', {}, { view: 'list' }, SCOPE_ALL) },
    { id: 'loading', label: 'Loading: each section in its shape', model: base('maintenance', { counts: loading, calendar: loading, plans: loading, register: loading, readAt: null }), note: '"Still loading…" shows after about a second.' },
    { id: 'error', label: "Couldn't load: each section on its own", model: base('maintenance', { counts: failed, calendar: failed, plans: failed, register: failed, readAt: null }), note: 'Each says so with Try again; a failed read is never drawn as empty.' },
    {
      id: 'empty',
      label: 'Nothing planned yet',
      model: base('maintenance', { counts: ready({ tiles: { OVERDUE: 0, DUE_SOON: 0, REPORTS_MISSING: 0 }, today: TODAY }), calendar: ready(calendarAnswer({ chips: [] })), plans: ready({ rows: [], next: null, more: false }), register: ready({ rows: [], next: null, more: false }) }),
      note: '"No checks planned · New plan · the check types come from Plant settings."',
    },
    { id: 'no-permission', label: 'Sales: no plant.view', model: base('sales', { counts: loading, calendar: loading, plans: loading, register: loading, readAt: null }), note: 'The page says so and reads nothing.' },
    { id: 'read-only', label: 'Read-only: every write held with its reason', model: base('readOnly'), note: 'New plan and Record a check result held "Needs plant.checks.manage"; no selection boxes for Move N; nothing drags.' },
    { id: 'safety-officer', label: 'Safety officer: looks (the checks reach the safety calendar)', model: base('safety') },
    { id: 'production-manager', label: 'Production manager: keeps the checks', model: base('production') },
    {
      id: 'new-plan',
      label: 'New plan: filled',
      model: base('maintenance', { planNew: planNew() }, { newPlan: true }),
      note: 'Machine · check type (its law and default) · interval · first due · reminder lead time (the day it goes) · outside body · owner · note.',
    },
    { id: 'new-plan-empty', label: 'New plan: empty (held)', model: base('maintenance', { planNew: planNew({ draft: EMPTY_PLAN, types: null, bodies: null, owners: null }) }, { newPlan: true }), note: 'Create plan says what is missing; the type, body and owner wait for the machine.' },
    {
      id: 'new-plan-exists',
      label: 'New plan: the machine has this plan already',
      model: base('maintenance', { planNew: planNew({ problem: { key: 'refusal.PLAN_EXISTS', field: null }, draft: { ...planNew().draft, replace: true, replaceReason: 'Passaggio da trimestrale a mensile' } }) }, { newPlan: true }),
      note: 'PLAN_EXISTS in our words; "End the current plan and start this one" with the reason.',
    },
    {
      id: 'record-failed',
      label: 'Record a check result: failed, job and lock in the same step',
      model: base('maintenance', { resultNew: resultNew() }, { record: LIFTING_PLAN.id }),
      note: 'Failed → "Make a job" (ticked) and "Lock as unsafe" with its reach, the reversal (H1) and the law; the report files go once the result is saved.',
    },
    {
      id: 'record-new',
      label: 'Record a check result: pick the machine',
      model: base('maintenance', { resultNew: resultNew({ plan: null, draft: newResultDraft(TODAY), machines: ready(MACHINES.slice(0, 3)), types: null }) }, { record: 'new' }),
      note: 'Without a plan: the machine and the check; its active plan is used when it has one.',
    },
    {
      id: 'record-locked',
      label: 'Record: the machine is locked already',
      model: base('maintenance', { resultNew: resultNew({ plan: ready(LIFTING_PLAN), draft: { ...resultNew().draft, lock: false } }) }, { record: LIFTING_PLAN.id }),
      note: 'Lock as unsafe is not offered: "locked as unsafe already: it stays do-not-use until a technician signs it safe".',
    },
    { id: 'record-rights', label: 'Record: a role without jobs and lock', model: base('checksOnly', { resultNew: resultNew({ draft: { ...resultNew().draft, makeJob: false, lock: false } }) }, { record: LIFTING_PLAN.id }), note: 'Both offers held, each naming its right (plant.jobs.manage, plant.report).' },
    {
      id: 'record-refused',
      label: 'Record: refused by the API',
      model: base('maintenance', { resultNew: resultNew({ problem: { key: 'refusal.LOCKED_ALREADY', field: null } }) }, { record: LIFTING_PLAN.id }),
      note: 'Someone locked the machine meanwhile: LOCKED_ALREADY in our words; nothing saved.',
    },
    {
      id: 'record-files',
      label: 'Record: a passed check with its report picked',
      model: base('maintenance', { resultNew: resultNew({ plan: ready(GUARDS_PLAN), draft: { ...withOutcome(newResultDraft(TODAY), 'PASSED'), performedBy: 'Manutenzione interna', files: [new File(['%PDF-1.4'], 'verbale-ripari-2026-11.pdf', { type: 'application/pdf' })] } }) }, { record: GUARDS_PLAN.id }),
    },
    {
      id: 'record-correct',
      label: 'Correct a result',
      model: base('maintenance', { resultNew: resultNew({ plan: null, corrects: ready(RESULTS[1]!), draft: { ...newResultDraft(TODAY), machineId: PRESS.id, checkTypeId: GUARDS.id, performedOn: '2026-09-27', outcome: 'PASSED', performedBy: 'Manutenzione interna', correctionReason: '' } }) }, { corrects: RESULT_IDS.guards }),
      note: 'A result never changes: the correction names it and asks why.',
    },
    { id: 'plan-detail', label: 'The Plan window', model: base('maintenance', { planOpen: { id: GUARDS_PLAN.id, read: ready(planRecord()) } }, { plan: GUARDS_PLAN.id }), note: 'Interval, next due, reminder, body and owner, the results and their report files. Record result; Move a check (m); J / K over the plans.' },
    { id: 'plan-detail-ended', label: 'The Plan window: an ended plan', model: base('maintenance', { planOpen: { id: ENDED_PLAN.id, read: ready(planRecord(ENDED_PLAN, { results: [] })) } }, { plan: ENDED_PLAN.id }), note: 'Record result and Move held: the plan is ended.' },
    { id: 'result-detail', label: 'A failed result: its job, the machine locked', model: base('maintenance', { resultOpen: resultOpen() }, { result: RESULT_IDS.lifting }), note: 'The job MJ-D-0012 is open (Make a job held); the machine is locked already (Lock held); the report is missing: the drop zone.' },
    {
      id: 'result-saved',
      label: 'Saved: job made and machine locked',
      model: base('maintenance', { resultOpen: resultOpen({ saved: { key: 'done.savedJobLock', params: { number: 'MJ-D-0012' } }, read: ready(resultRecord(RESULTS[0], { result: { ...RESULTS[0]!, reports: reportFile('verbale-carrello-2026-10.pdf'), reportOnFile: true } })) }) }, { result: RESULT_IDS.lifting }),
    },
    {
      id: 'result-lock',
      label: 'Lock as unsafe afterwards',
      model: base('maintenance', { resultOpen: resultOpen({ step: 'lock', lockNote: 'Controllare la catena', read: ready(resultRecord(RESULTS[0], { machine: { id: FORKLIFT.id, assetNumber: FORKLIFT.assetNumber, status: 'RUNNING', locked: false }, canLock: true })) }) }, { result: RESULT_IDS.lifting }),
      note: 'The reach, the reversal, that it joins the open job, the law; a note for the technician.',
    },
    { id: 'result-refused', label: 'Make a job refused: one is open', model: base('maintenance', { resultOpen: resultOpen({ problem: { key: 'refusal.JOB_EXISTS', field: null } }) }, { result: RESULT_IDS.lifting }) },
    { id: 'result-corrected', label: 'A corrected result', model: base('maintenance', { resultOpen: resultOpen({ id: RESULT_IDS.wrongDay, read: ready(resultRecord(RESULTS[2])) }) }, { result: RESULT_IDS.wrongDay }), note: 'Corrected by the result of 27 Apr: Correct held (a result is corrected once).' },
    { id: 'move', label: 'Move a check (a drag)', model: base('maintenance', { move: move() }, { move: VESSEL_PLAN.id, date: '2026-11-27' }), note: 'Dropped on 27 Nov: "7 days later"; the reason is asked.' },
    { id: 'move-held', label: 'Move: before the first due date (held)', model: base('maintenance', { move: move({ draft: { nextDueOn: '2024-10-01', reason: 'Visita anticipata' } }) }, { move: VESSEL_PLAN.id }) },
    { id: 'move-many', label: 'Move N', model: base('maintenance', { move: move({ bulk: true, plans: ready([GUARDS_PLAN, VESSEL_PLAN]), draft: { nextDueOn: '2026-11-27', reason: 'Visita dell’ente unica per le due macchine' } }), selected: [GUARDS_PLAN.id, VESSEL_PLAN.id] }) },
    {
      id: 'bulk-result',
      label: 'Move N: one plan refused',
      model: base('maintenance', { notice: { tone: 'warning', key: 'bulk.moveResult', params: { count: 1 }, refused: [{ label: 'DEMO-CP-01 · PRESS_GUARDS', key: 'refusal.BEFORE_FIRST_DUE' }] } }),
    },
    { id: 'keys', label: 'The keys', model: base('maintenance', { keysOpen: true }) },
  ],
})
