import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import type { OfficeScope } from '../../../shell/scope/scope-model'
import {
  BOOKED_VISIT,
  DOCTORS,
  DONE_VISIT,
  frameFor,
  GIULIA,
  HEALTH_ROLES_DEMO,
  inHealthShell,
  JUDGEMENTS,
  JUDGEMENTS_ALL,
  judgementOf,
  LIMITS_JUDGEMENT,
  NOW,
  PEOPLE,
  PERIODIC_VISIT,
  PLAN_CUT,
  PLAN_FIN,
  PLAN_SOUTH,
  plansFor,
  PREFIX,
  PROPOSALS,
  RETURN_VISIT,
  SCOPE_ALL,
  SCOPE_ONE,
  SHOWN,
  STARTER_VISIT,
  TODAY,
  VIEWS,
  visitOf,
  VISITS,
  VISITS_ALL_SITES,
  VISITS_ALL_STATES,
  type HealthRoleDemo,
} from './_demo/fixtures'
import type { VisitRow } from './api'
import { EMPTY_ADDRESS, healthCan, newBookDraft, newByHand, newJudgementDraft, newMoveDraft, planDraftOf, proposalKey, type HealthAddress } from './model'
import type { HealthPageModel, JudgementDialogState, JudgementWindowState, PlanVisitsState, VisitWindowState } from './view-model'
import { HealthView } from './view/HealthView'

/**
 * SCR-212 — Plant › Health & safety › Health surveillance (B-W2b-148; design plant.health). Made-up data only (./_demo): an
 * invented company with two sites, invented people, role sheets, visits, judgements, task limits and an invented occupational
 * doctor. Roles from factory-domain's templates: HR keeps the visits and judgements and reads who looked; the occupational doctor
 * keeps them and the plans; the safety officer keeps the plans only (no person); the production manager and read-only see
 * nothing. The labels and notes are English (the design index only); the screen's words come from the catalogues.
 */

interface HealthCase {
  role: HealthRoleDemo
  model: HealthPageModel
}

const ready = <T,>(value: T) => ({ status: 'ready' as const, value })
const loading = { status: 'loading' as const }
const failed = { status: 'error' as const, problem: 'problem.read' }

function base(role: HealthRoleDemo, over: Partial<HealthPageModel> = {}, address: Partial<HealthAddress> = {}, scope: OfficeScope = SCOPE_ONE, visits: readonly VisitRow[] = VISITS): HealthCase {
  const can = healthCan(HEALTH_ROLES_DEMO[role])
  const full = can.view
  return {
    role,
    model: {
      prefix: PREFIX,
      can,
      scope,
      companyId: scope.company?.id ?? null,
      address: { ...EMPTY_ADDRESS, ...address },
      today: TODAY,
      frame: full ? ready(frameFor(role)) : loading,
      due: full ? ready({ rows: visits, more: false, at: NOW }) : null,
      dueMore: false,
      dueUpdates: 0,
      judgements: full ? ready({ rows: JUDGEMENTS, more: false }) : null,
      judgementsMore: false,
      judgementUpdates: 0,
      shown: { state: 'hidden' },
      plans: can.plansRead ? ready(plansFor(role, scope.allSites ? [...plansFor(role), PLAN_SOUTH] : undefined)) : null,
      readAt: full ? NOW : null,
      notice: null,
      dueSelected: [],
      judgementSelected: [],
      whoLooked: null,
      book: null,
      judge: null,
      planVisits: null,
      visit: null,
      judgement: null,
      plan: null,
      ...over,
    },
  }
}

const judgeState = (over: Partial<JudgementDialogState> = {}): JudgementDialogState => ({ draft: newJudgementDraft(TODAY, PERIODIC_VISIT), fromWindow: null, picked: null, people: null, peopleQuery: '', copy: null, busy: false, problem: null, savedWithoutCopy: null, ...over })
const planVisitsState = (over: Partial<PlanVisitsState> = {}): PlanVisitsState => ({ proposals: ready({ proposals: PROPOSALS, at: NOW }), chosen: PROPOSALS.slice(0, 2).map(proposalKey), byHand: [], picking: null, people: null, peopleQuery: '', busy: false, problem: null, ...over })
const visitState = (row: VisitRow, over: Partial<VisitWindowState> = {}): VisitWindowState => ({ id: row.id, read: ready({ visit: visitOf(row), at: NOW }), move: null, busy: false, problem: null, ...over })
const judgementState = (over: Partial<JudgementWindowState> = {}): JudgementWindowState => ({ id: LIMITS_JUDGEMENT.id, read: ready({ judgement: judgementOf(), at: NOW }), mode: 'view', reason: null, copy: null, busy: false, problem: null, ...over })
const copyFile = { name: 'giudizio-scansione.pdf', type: 'application/pdf', size: 120_000 } as unknown as File

function HealthDesign({ model }: { model: HealthCase }) {
  return inHealthShell('/plant/health', createElement(HealthView, { model: model.model }), model.role, model.model.scope)
}

export const designScreen = defineDesignScreen<HealthCase>({
  screen: 'SCR-212',
  title: 'Health surveillance (Plant › Health & safety)',
  view: HealthDesign,
  cases: [
    {
      id: 'hr',
      label: 'HR: the protected page, the due list, the judgements (anonymised), the plans',
      model: base('hr'),
      note: 'The PrivacyNote first (who sees it, GDPR art. 9, every view recorded, Who looked at the lists), live use waits for the doctor, the five tiles, the due list (its reading recorded, said above it), the judgements with person, outcome and limits Restricted until Show, the plans per role. j records a judgement, p plans visits.',
    },
    { id: 'doctor', label: 'The occupational doctor: keeps visits, judgements and plans; no Who looked', model: base('doctor') },
    { id: 'all-sites', label: 'All sites: a Site column and the site chip', model: base('hr', {}, {}, SCOPE_ALL, VISITS_ALL_SITES) },
    { id: 'tile-overdue', label: 'Tile "Visits overdue" as the filter', model: base('hr', {}, { tile: 'overdue' }) },
    { id: 'status-all', label: 'Every status: done and cancelled visits cannot be chosen (said on their box)', model: base('hr', {}, { status: 'all' }, SCOPE_ONE, VISITS_ALL_STATES) },
    { id: 'selected', label: 'Two visits chosen: Mark 2 booked and Print 2 for the doctor', model: base('hr', { dueSelected: [RETURN_VISIT.id, STARTER_VISIT.id] }) },
    { id: 'book', label: 'Mark booked: "Mark 2 booked for 14 Nov"', model: base('hr', { dueSelected: [RETURN_VISIT.id, STARTER_VISIT.id], book: { ids: [RETURN_VISIT.id, STARTER_VISIT.id], draft: { on: '2026-11-14', place: 'Ambulatorio Demo, via Esempio 1' }, busy: false, problem: null } }) },
    { id: 'book-empty', label: 'Mark booked: held "Choose the day of the visit."', model: base('hr', { book: { ids: [RETURN_VISIT.id], draft: newBookDraft(), busy: false, problem: null } }) },
    { id: 'book-past', label: 'Mark booked: a day in the past is held with the API\'s words', model: base('hr', { book: { ids: [RETURN_VISIT.id], draft: { on: '2026-11-01', place: '' }, busy: false, problem: null } }) },
    { id: 'show-confirm', label: 'Show: the PrivacyNote said before anything is read', model: base('hr', { shown: { state: 'confirm', ids: JUDGEMENTS.map((row) => row.id) } }) },
    { id: 'shown', label: 'Shown: person, outcome and task limits of 3 rows, each view recorded', model: base('hr', { shown: { state: 'shown', byId: SHOWN, at: NOW } }) },
    { id: 'judgements-all', label: 'Every judgement: superseded and voided kept', model: base('hr', { judgements: ready({ rows: JUDGEMENTS_ALL, more: false }) }, { jstate: 'all' }) },
    { id: 'judge', label: 'Record a judgement: from a visit; Save held "Choose the outcome."', model: base('doctor', { judge: judgeState() }, { judge: PERIODIC_VISIT.id }) },
    {
      id: 'judge-limits',
      label: 'Record a judgement: fit with limits, the hint under the field, a copy chosen',
      model: base('doctor', { judge: judgeState({ draft: { ...newJudgementDraft(TODAY, PERIODIC_VISIT), outcome: 'FIT_WITH_LIMITS', taskLimits: 'Niente sollevamento oltre 15 kg.', expiresOn: '2027-11-05' }, copy: copyFile }) }, { judge: PERIODIC_VISIT.id }),
      note: 'Hint: "Write the task limit only, e.g. no lifting over 15 kg. Never the medical reason."',
    },
    {
      id: 'judge-clinical',
      label: 'Record a judgement: a medical word in the limits is held at once',
      model: base('doctor', { judge: judgeState({ draft: { ...newJudgementDraft(TODAY, PERIODIC_VISIT), outcome: 'FIT_WITH_LIMITS', taskLimits: 'Ernia del disco: niente sollevamento' } }) }, { judge: PERIODIC_VISIT.id }),
    },
    { id: 'judge-unfit', label: 'Record a judgement: temporarily unfit until a day', model: base('doctor', { judge: judgeState({ draft: { ...newJudgementDraft(TODAY, RETURN_VISIT), outcome: 'TEMPORARILY_UNFIT', unfitUntil: '2026-12-05' } }) }, { judge: RETURN_VISIT.id }) },
    { id: 'judge-person', label: 'Record a judgement by hand (HR): a person of the staff list', model: base('hr', { judge: judgeState({ draft: { ...newJudgementDraft(TODAY), from: 'person' }, people: ready({ people: PEOPLE, complete: true }), peopleQuery: 'Demo' }) }, { judge: '1' }) },
    { id: 'judge-doctor-hand', label: 'The doctor: a person by hand is held (the staff list is HR\'s)', model: base('doctor', { judge: judgeState({ draft: newJudgementDraft(TODAY) }) }, { judge: '1' }) },
    { id: 'judge-refused', label: 'Record a judgement refused: the visit has its judgement already', model: base('doctor', { judge: judgeState({ draft: { ...newJudgementDraft(TODAY, PERIODIC_VISIT), outcome: 'FIT' }, problem: { key: 'refusal.VISIT_JUDGED', field: null, item: null } }) }, { judge: PERIODIC_VISIT.id }) },
    { id: 'judge-no-copy', label: 'Saved, but the copy was not taken: open the judgement to add it', model: base('doctor', { judge: judgeState({ savedWithoutCopy: LIMITS_JUDGEMENT.id, problem: { key: 'problem.unavailable', field: null, item: null } }) }, { judge: '1' }) },
    { id: 'plan-visits', label: 'Plan visits: the proposals (recorded), why, whether the doctor set the plan', model: base('hr', { planVisits: planVisitsState() }, { planVisits: true }) },
    {
      id: 'plan-visits-hand',
      label: 'Plan visits: a return after 75 days added by hand (its length only)',
      model: base('hr', { planVisits: planVisitsState({ byHand: [{ ...newByHand('h1', TODAY), employeeId: GIULIA.id, name: GIULIA.name, type: 'RETURN_AFTER_ABSENCE', absenceDays: '75' }, newByHand('h2', TODAY)], picking: 'h2', people: ready({ people: PEOPLE, complete: true }) }) }, { planVisits: true }),
    },
    { id: 'plan-visits-refused', label: 'Plan visits refused: one person has a visit of that type open', model: base('hr', { planVisits: planVisitsState({ problem: { key: 'refusal.OPEN_VISIT_EXISTS', field: 'type', item: 1, params: { n: 2 } } }) }, { planVisits: true }) },
    { id: 'plan-visits-none', label: 'Plan visits: nothing to propose', model: base('hr', { planVisits: planVisitsState({ proposals: ready({ proposals: [], at: NOW }), chosen: [] }) }, { planVisits: true }) },
    { id: 'plan-visits-loading', label: 'Plan visits: reading the proposals', model: base('hr', { planVisits: planVisitsState({ proposals: loading, chosen: [] }) }, { planVisits: true }) },
    { id: 'visit', label: 'A return visit: its window (recorded), the absence\'s length only', model: base('hr', { visit: visitState(RETURN_VISIT) }, { visit: RETURN_VISIT.id }) },
    { id: 'visit-booked', label: 'A booked visit: who booked it, where; Unbook', model: base('hr', { visit: visitState(BOOKED_VISIT) }, { visit: BOOKED_VISIT.id }) },
    { id: 'visit-cancel', label: 'Cancel a visit: a reason from the list (no free text)', model: base('hr', { visit: visitState(PERIODIC_VISIT, { move: newMoveDraft('cancel', TODAY, PERIODIC_VISIT) }) }, { visit: PERIODIC_VISIT.id }) },
    { id: 'visit-book', label: 'Book one visit from its window', model: base('hr', { visit: visitState(PERIODIC_VISIT, { move: { ...newMoveDraft('book', TODAY, PERIODIC_VISIT), day: '2026-11-18', place: 'Ambulatorio Demo' } }) }, { visit: PERIODIC_VISIT.id }) },
    { id: 'visit-done', label: 'A visit done, with its judgement', model: base('hr', { visit: visitState(DONE_VISIT) }, { visit: DONE_VISIT.id }) },
    { id: 'visit-loading', label: 'A visit loading', model: base('hr', { visit: visitState(RETURN_VISIT, { read: loading }) }, { visit: RETURN_VISIT.id }) },
    { id: 'visit-error', label: 'A visit failed', model: base('hr', { visit: visitState(RETURN_VISIT, { read: failed }) }, { visit: RETURN_VISIT.id }) },
    { id: 'judgement', label: 'A judgement: its window (recorded), the copy opens in its own tab', model: base('hr', { judgement: judgementState() }, { judgement: LIMITS_JUDGEMENT.id }) },
    { id: 'judgement-void', label: 'Void a judgement: a reason from the list; kept, never changed', model: base('doctor', { judgement: judgementState({ mode: 'void', reason: 'WRONG_DETAILS' }) }, { judgement: LIMITS_JUDGEMENT.id }) },
    { id: 'judgement-copy', label: 'Add the doctor\'s copy', model: base('doctor', { judgement: judgementState({ mode: 'copy' }) }, { judgement: LIMITS_JUDGEMENT.id }) },
    {
      id: 'judgement-voided',
      label: 'A voided judgement: why, who, when; Void and copy held',
      model: base('hr', { judgement: judgementState({ read: ready({ judgement: judgementOf({ state: 'VOIDED', voided: { at: '2026-10-16T09:00:00.000Z', by: { id: GIULIA.id, name: 'Anna Demo (HR)' }, reason: 'WRONG_DETAILS' } }), at: NOW }) }) }, { judgement: LIMITS_JUDGEMENT.id }),
    },
    { id: 'plan-edit', label: 'Safety officer: a role\'s plan — how often, the doctor, end of employment', model: base('safety', { plan: { plan: plansFor('safety')[0]!, draft: { ...planDraftOf(PLAN_CUT, TODAY), frequency: '24' }, doctors: ready(DOCTORS), busy: false, problem: null } }, { plan: PLAN_CUT.id }) },
    { id: 'plan-edit-not-needed', label: 'A role that needs no visits: frequency held (the role sheet decides)', model: base('doctor', { plan: { plan: plansFor('doctor')[2]!, draft: { ...planDraftOf(PLAN_FIN, TODAY), frequency: '12' }, doctors: ready(DOCTORS), busy: false, problem: null } }, { plan: PLAN_FIN.id }) },
    { id: 'who-looked', label: 'Who looked at the lists (HR): viewer, time, what', model: base('hr', { whoLooked: { of: { companyId: SCOPE_ONE.company!.id, lists: true }, read: ready(VIEWS) } }) },
    { id: 'safety-officer', label: 'Safety officer: the plans only, no person', model: base('safety') },
    { id: 'notice', label: 'After Mark booked: the notice', model: base('hr', { notice: { tone: 'success', key: 'notice.booked', params: { count: 2, day: '14 nov 2026' } } }) },
    { id: 'updates', label: 'Live changes wait: "2 updates · Show" (a re-read is a recorded view)', model: base('hr', { dueUpdates: 2, judgementUpdates: 1 }) },
    { id: 'loading', label: 'Loading: the note first, nothing named before it', model: base('hr', { frame: loading, due: null, judgements: null, plans: null, readAt: null }) },
    { id: 'lists-loading', label: 'The note read: the lists loading in their shape', model: base('hr', { due: loading, judgements: loading, plans: loading }) },
    { id: 'error', label: 'The note failed: said with Try again; nothing else read', model: base('hr', { frame: failed, due: null, judgements: null, plans: null, readAt: null }) },
    { id: 'lists-error', label: 'The lists failed: said with Try again, never drawn as empty', model: base('hr', { due: failed, judgements: failed, plans: failed }) },
    {
      id: 'empty',
      label: 'Nothing due, no judgements yet',
      model: base('hr', { frame: ready({ ...frameFor('hr'), tiles: { overdue: 0, dueIn30: 0, beforeTask: 0, returnVisits: 0, unfitEnding: 0 } }), due: ready({ rows: [], more: false, at: NOW }), judgements: ready({ rows: [], more: false }) }),
    },
    { id: 'filtered-empty', label: 'Filters match nothing', model: base('hr', { due: ready({ rows: [], more: false, at: NOW }) }, { type: 'END_OF_EMPLOYMENT' }) },
    { id: 'no-permission', label: 'Production manager: no access (said; nothing read)', model: base('production') },
    { id: 'read-only', label: 'Read-only role: no access to health data', model: base('readOnly') },
    { id: 'keys', label: 'Keyboard shortcuts (?)', model: base('hr', { keysOpen: true }) },
  ],
})
