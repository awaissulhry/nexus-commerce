import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import type { OfficeScope } from '../../../shell/scope/scope-model'
import {
  assessmentsAnswer,
  CATALOGUE,
  COUNTS,
  CUTTER,
  CUTTER_PREVIEW,
  DONE_MEASURE,
  EMPTY_SOUTH,
  inRiskShell,
  MEASURES,
  measuresAnswer,
  NORTH,
  northRecord,
  NOW,
  OWNERS,
  PREFIX,
  RISK_ROLES_DEMO,
  SCOPE_ALL,
  SCOPE_ONE,
  SHEET_ROWS,
  sheetsAnswer,
  SITE_S,
  SOUTH,
  SOUTH_ROW,
  TODAY,
  V3,
  VISITS_PREVIEW,
  type RiskRoleDemo,
} from './_demo/fixtures'
import { EMPTY_ADDRESS, EMPTY_MEASURE, emptyVersionDraft, riskCan, sheetDraftOf, type RiskAddress } from './model'
import type { MeasureDialogState, RiskPageModel, SheetState, VersionDialogState } from './view-model'
import { RiskPageView } from './view/RiskPageView'

/**
 * SCR-209 — Plant › Health & safety › Risk assessment (B-W2b-144; design plant.risk). Made-up data only (./_demo): an invented
 * company with two sites, invented assessments, versions, signers, measures and role sheets. Roles from factory-domain's
 * templates: the safety officer keeps everything (with the cost grain the cost shows); the occupational doctor signs and
 * reads; the production manager reads and moves the measures they own; read-only reads; sales has no safety.view. The labels
 * and notes are English (the design index only); the screen's words come from the catalogues.
 */

interface RiskCase {
  role: RiskRoleDemo
  model: RiskPageModel
}

const ready = <T,>(value: T) => ({ status: 'ready' as const, value })
const loading = { status: 'loading' as const }
const failed = { status: 'error' as const, problem: 'problem.read' }

function base(role: RiskRoleDemo, over: Partial<RiskPageModel> = {}, address: Partial<RiskAddress> = {}, scope: OfficeScope = SCOPE_ONE): RiskCase {
  const can = riskCan(RISK_ROLES_DEMO[role])
  return {
    role,
    model: {
      prefix: PREFIX,
      can,
      scope,
      companyId: scope.company?.id ?? null,
      today: TODAY,
      address: { ...EMPTY_ADDRESS, ...address },
      counts: ready(COUNTS),
      assessments: ready(assessmentsAnswer({ canManage: can.manage, assessments: [{ ...NORTH, canManage: can.manage }] })),
      measures: ready(measuresAnswer(MEASURES.map((row) => ({ ...row, canManage: can.manage, canMove: can.manage ? row.canMove : role === 'production' && row.ownerId === OWNERS[0]!.id ? row.canMove.filter((to) => to !== 'CANCELLED') : [] })), can.cost)),
      sheets: ready(sheetsAnswer(SHEET_ROWS.map((row) => ({ ...row, canManage: can.sheets })), can.sheets)),
      readAt: NOW,
      notice: null,
      selected: { assessments: [], measures: [], sheets: [] },
      cells: {},
      owners: can.manage ? ready(OWNERS) : null,
      measure: null,
      move: null,
      version: null,
      sheet: null,
      newSheet: null,
      ...over,
    },
  }
}

const measureDialog = (over: Partial<MeasureDialogState> = {}): MeasureDialogState => ({
  mode: 'add',
  id: null,
  read: null,
  draft: { ...EMPTY_MEASURE, assessmentId: NORTH.id },
  owners: ready(OWNERS),
  sheets: ready(SHEET_ROWS),
  busy: false,
  uploading: false,
  problem: null,
  ...over,
})

const filledMeasure = { ...EMPTY_MEASURE, assessmentId: NORTH.id, title: 'Carter di protezione sulla cucitrice a braccio', risk: 'Impigliamento', roleSheetIds: [SHEET_ROWS[1]!.id], ownerId: OWNERS[0]!.id, dueOn: '2027-01-31', cost: '850,00' }

const versionDialog = (over: Partial<VersionDialogState> = {}): VersionDialogState => ({
  draft: emptyVersionDraft(NORTH.id, TODAY),
  record: ready(northRecord({ versions: northRecord().versions.slice(1) })),
  busy: false,
  step: 'fill',
  addingAssessment: false,
  problem: null,
  frozen: null,
  ...over,
})

const filledVersion = { ...emptyVersionDraft(NORTH.id, TODAY), file: { name: 'DVR-demo-rev3.pdf', type: 'application/pdf', size: 1_920_000 }, sha256: 'c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3', label: 'Rev. 3', effectiveOn: '2026-11-01', authorName: 'Studio Esempio Sicurezza', changeSummary: 'Nuovo reparto finissaggio con banco colle e aspirazione.' }

const sheetState = (over: Partial<SheetState> = {}): SheetState => ({
  id: CUTTER.id,
  read: ready({ roleSheet: CUTTER, law: sheetsAnswer().law, today: TODAY }),
  mode: 'view',
  draft: null,
  catalogue: null,
  review: null,
  busy: false,
  problem: null,
  saved: null,
  ...over,
})

const cutterDraft = sheetDraftOf(CUTTER)
const changedDraft = {
  ...cutterDraft,
  items: [...cutterDraft.items, { key: 'item-new', kind: 'RISK' as const, title: 'Polveri di pelle al banco', note: '' }],
  kit: [...cutterDraft.kit.map((line, index) => (index === 0 ? { ...line, quantity: '3' } : line)), { key: 'kit-new', ppeItemId: CATALOGUE.ppeItems[3]!.id, quantity: '1', whenToWear: 'Al banco colle', note: '' }],
  requirements: cutterDraft.requirements.map((line, index) => (index === 1 ? { ...line, withinDays: '30' } : line)),
}

function RiskDesign({ model }: { model: RiskCase }) {
  return inRiskShell('/plant/risk', createElement(RiskPageView, { model: model.model }), model.role, model.model.scope)
}

export const designScreen = defineDesignScreen<RiskCase>({
  screen: 'SCR-209',
  title: 'Risk assessment (Plant › Health & safety)',
  view: RiskDesign,
  cases: [
    {
      id: 'normal',
      label: 'Safety officer: tiles, assessments, the improvement plan, the role sheets',
      model: base('safety'),
      note: 'The band says the version in force of the top bar\'s site ("v2 · certain date"). Assessments: v2 in force, v3 waiting (employer and RSPP signed). The plan with inline owner, due and status (no cost column without the cost grain: Columns ▾ says it). c adds a measure.',
    },
    { id: 'cost', label: 'Safety officer with the cost grain: the measures\' cost', model: base('safetyCost') },
    { id: 'all-sites', label: 'All sites: Site columns and the site chip', model: base('safety', { assessments: ready(assessmentsAnswer({ assessments: [NORTH, SOUTH] })), measures: ready(measuresAnswer([...MEASURES, { ...MEASURES[2]!, id: 'south-1', assessmentId: SOUTH.id, assessment: SOUTH.name, siteId: SITE_S.id, site: { code: SITE_S.code, name: SITE_S.name } }])), sheets: ready(sheetsAnswer([...SHEET_ROWS, SOUTH_ROW])) }, {}, SCOPE_ALL) },
    { id: 'tile-reviews', label: 'Tile "DVR review due" filters the assessments', model: base('safety', {}, { tile: 'reviews' }) },
    { id: 'tile-signatures', label: 'Tile "Signatures missing" filters the assessments', model: base('safety', {}, { tile: 'signatures' }) },
    { id: 'tile-roles', label: 'Tile "Roles without PPE kit or training set" filters the role sheets', model: base('safety', {}, { tile: 'roles' }) },
    { id: 'view-overdue', label: 'Tile "Measures overdue": the plan\'s view', model: base('safety', { measures: ready(measuresAnswer([MEASURES[0]!])) }, { view: 'overdue' }) },
    { id: 'selected', label: 'Rows chosen: Print plan, Print 2, Print 2 role sheets', model: base('safety', { selected: { assessments: [NORTH.id], measures: [MEASURES[0]!.id, MEASURES[1]!.id], sheets: [SHEET_ROWS[0]!.id, SHEET_ROWS[1]!.id] } }) },
    { id: 'cell-saving', label: 'Inline cells: saving, saved, refused in words', model: base('safety', { cells: { [`${MEASURES[0]!.id}:owner`]: { state: 'saving' }, [`${MEASURES[1]!.id}:due`]: { state: 'saved' }, [`${MEASURES[2]!.id}:status`]: { state: 'refused', key: 'refusal.BAD_MOVE' } } }) },
    { id: 'empty', label: 'No assessment yet: "Add the current DVR"', model: base('safety', { counts: ready({ ...COUNTS, measuresOverdue: 0, measuresDueSoon: 0, reviewsDue: 0, signaturesMissing: 0, rolesWithoutKitOrTraining: 0, assessments: 0 }), assessments: ready(assessmentsAnswer({ assessments: [] })), measures: ready(measuresAnswer([])), sheets: ready(sheetsAnswer([])) }) },
    { id: 'loading', label: 'Loading: each section in its shape', model: base('safety', { counts: loading, assessments: loading, measures: loading, sheets: loading, readAt: null }) },
    { id: 'error', label: 'Failed reads: said with Try again, never drawn as empty', model: base('safety', { counts: failed, assessments: failed, measures: failed, sheets: failed }) },
    { id: 'production', label: 'Production manager: reads; moves the measures they own; Add measure held with the reason', model: base('production') },
    { id: 'doctor', label: 'Occupational doctor: reads and signs (on the record)', model: base('doctor') },
    { id: 'read-only', label: 'Read-only role', model: base('readOnly') },
    { id: 'no-permission', label: 'Sales: no safety.view', model: base('sales') },
    { id: 'notice', label: 'After a freeze: the notice', model: base('safety', { notice: { tone: 'success', key: 'notice.frozen', params: { version: 'v3', assessment: NORTH.name } } }) },
    { id: 'add-measure', label: 'Add measure: the assessment of the site chosen; Add held "Say what is to be done."', model: base('safety', { measure: measureDialog() }, { add: 'measure' }) },
    { id: 'add-measure-filled', label: 'Add measure filled (with the cost grain)', model: base('safetyCost', { measure: measureDialog({ draft: filledMeasure }) }, { add: 'measure' }) },
    { id: 'add-measure-all-sites', label: 'Add measure with All sites: choose the assessment first', model: base('safety', { assessments: ready(assessmentsAnswer({ assessments: [NORTH, SOUTH] })), measure: measureDialog({ draft: { ...EMPTY_MEASURE }, sheets: null }) }, { add: 'measure' }, SCOPE_ALL) },
    { id: 'add-measure-refused', label: 'Add measure refused: the owner does not read the safety pages', model: base('safety', { measure: measureDialog({ draft: filledMeasure, problem: { key: 'refusal.OWNER_NOT_ALLOWED', field: 'ownerId' } }) }, { add: 'measure' }) },
    { id: 'move-done', label: 'Mark done: what was done and the evidence files', model: base('safety', { move: { measure: MEASURES[1]!, to: 'DONE', evidenceNote: 'Aspiratore installato e collaudato.', reason: '', files: [{ name: 'collaudo-demo.pdf', size: 120_000 }], busy: false, problem: null } }) },
    { id: 'move-cancel', label: 'Cancel a measure: held until the reason is typed', model: base('safety', { move: { measure: MEASURES[3]!, to: 'CANCELLED', evidenceNote: '', reason: '', files: [], busy: false, problem: null } }) },
    { id: 'version', label: 'New DVR version: the PDF, its fingerprint on this device, the signers', model: base('safety', { version: versionDialog({ draft: filledVersion }) }, { add: 'version' }), note: 'Freeze and send for signature uploads the PDF to the assessment, then freezes it. The signers are the safety organisation of the site today.' },
    { id: 'version-empty', label: 'New DVR version: held "Choose the consultant\'s PDF."', model: base('safety', { version: versionDialog() }, { add: 'version' }) },
    { id: 'version-waiting', label: 'New DVR version held: a version already waits for signatures', model: base('safety', { version: versionDialog({ record: ready(northRecord()) }) }, { add: 'version' }) },
    { id: 'version-no-employer', label: 'New DVR version held: nobody holds the employer\'s role', model: base('safety', { version: versionDialog({ draft: filledVersion, record: ready(northRecord({ versions: northRecord().versions.slice(1), next: { signers: [], sameAs: [], missingEmployer: true } })) }) }, { add: 'version' }) },
    { id: 'version-same-person', label: 'New DVR version: the employer also acts as RSPP (one signature)', model: base('safety', { version: versionDialog({ draft: filledVersion, record: ready(northRecord({ versions: northRecord().versions.slice(1), next: { signers: [{ role: 'EMPLOYER', appointmentId: 'a', name: 'Giulia Esempio' }, { role: 'RLS', appointmentId: 'b', name: 'Sara Prova' }, { role: 'DOCTOR', appointmentId: 'c', name: 'Dott.ssa Anna Fittizia' }], sameAs: [{ role: 'EMPLOYER', as: 'RSPP', name: 'Giulia Esempio' }], missingEmployer: false } })) }) }, { add: 'version' }) },
    { id: 'version-new-site', label: '"Add the current DVR" for a site without an assessment', model: base('safety', { assessments: ready(assessmentsAnswer({ assessments: [NORTH] })), version: versionDialog({ draft: { ...emptyVersionDraft(null, TODAY), newSiteId: SITE_S.id, newName: SITE_S.name }, record: null }) }, { add: 'version' }, SCOPE_ALL) },
    { id: 'version-uploading', label: 'Freezing: the PDF going to the store', model: base('safety', { version: versionDialog({ draft: filledVersion, busy: true, step: 'uploading' }) }, { add: 'version' }) },
    { id: 'version-frozen', label: 'Frozen: the seal and who it waits for', model: base('safety', { version: versionDialog({ draft: filledVersion, frozen: V3() }) }, { add: 'version' }) },
    { id: 'sheet', label: 'A role sheet from the index: risks, PPE with when to wear, courses, visits, people', model: base('safety', { sheet: sheetState() }, { sheet: CUTTER.id }), note: 'J / K walk the index; Edit sheet, Print and Archive (held while people are in the role) in the header.' },
    { id: 'sheet-edit', label: 'Edit the sheet: the whole sheet under the EditModeBar (⌘S reviews)', model: base('safety', { sheet: sheetState({ mode: 'edit', draft: changedDraft, catalogue: ready(CATALOGUE) }) }, { sheet: CUTTER.id, mode: 'edit' }) },
    { id: 'sheet-edit-problem', label: 'Edit: "Name the surveillance need first" before visits are needed', model: base('safety', { sheet: sheetState({ mode: 'edit', draft: { ...cutterDraft, items: cutterDraft.items.filter((item) => item.kind === 'RISK'), needed: true }, catalogue: ready(CATALOGUE) }) }, { sheet: CUTTER.id, mode: 'edit' }) },
    { id: 'sheet-impact', label: 'What this changes: who needs which course and kit item', model: base('safety', { sheet: sheetState({ mode: 'edit', draft: changedDraft, catalogue: ready(CATALOGUE), review: { read: ready(CUTTER_PREVIEW), applying: false, applied: null, problem: null } }) }, { sheet: CUTTER.id, mode: 'edit' }) },
    { id: 'sheet-impact-visits', label: 'What this changes: "4 people get a yearly visit" (counts only)', model: base('safety', { sheet: sheetState({ mode: 'edit', draft: changedDraft, catalogue: ready(CATALOGUE), review: { read: ready(VISITS_PREVIEW), applying: false, applied: null, problem: null } }) }, { sheet: CUTTER.id, mode: 'edit' }) },
    { id: 'sheet-impact-changed', label: 'Apply refused: something changed meanwhile, read again', model: base('safety', { sheet: sheetState({ mode: 'edit', draft: changedDraft, catalogue: ready(CATALOGUE), review: { read: ready(CUTTER_PREVIEW), applying: false, applied: null, problem: { key: 'sheetRefusal.IMPACT_CHANGED', field: null } } }) }, { sheet: CUTTER.id, mode: 'edit' }) },
    { id: 'sheet-impact-reading', label: 'What this changes: reading', model: base('safety', { sheet: sheetState({ mode: 'edit', draft: changedDraft, catalogue: ready(CATALOGUE), review: { read: loading, applying: false, applied: null, problem: null } }) }, { sheet: CUTTER.id, mode: 'edit' }) },
    { id: 'sheet-applied', label: 'After Apply: the sheet says it', model: base('safety', { sheet: sheetState({ saved: { key: 'sheet.applied', params: { count: 3 } } }) }, { sheet: CUTTER.id }) },
    { id: 'sheet-read-only', label: 'Production manager: the sheet read; Edit held with the reason', model: base('production', { sheet: sheetState({ read: ready({ roleSheet: { ...CUTTER, canManage: false }, law: sheetsAnswer().law, today: TODAY }) }) }, { sheet: CUTTER.id }) },
    { id: 'sheet-loading', label: 'The sheet loading', model: base('safety', { sheet: sheetState({ read: loading }) }, { sheet: CUTTER.id }) },
    { id: 'sheet-error', label: 'The sheet failed', model: base('safety', { sheet: sheetState({ read: failed }) }, { sheet: CUTTER.id }) },
    { id: 'add-role', label: 'Add role: code and name; the sheet opens to fill', model: base('safety', { newSheet: { siteId: SCOPE_ONE.site!.id, code: 'STI', name: 'Stiratrice', description: '', busy: false, problem: null } }, { add: 'role' }) },
    { id: 'add-role-taken', label: 'Add role refused: the code is taken', model: base('safety', { newSheet: { siteId: SCOPE_ONE.site!.id, code: 'TAG', name: 'Tagliatore 2', description: '', busy: false, problem: { key: 'sheetRefusal.CODE_TAKEN', field: 'code' } } }, { add: 'role' }) },
    { id: 'empty-south', label: 'A site with an assessment but no version yet', model: base('safety', { assessments: ready(assessmentsAnswer({ assessments: [EMPTY_SOUTH] })) }, {}, SCOPE_ALL) },
    { id: 'done-measure', label: 'Done and verified view', model: base('safety', { measures: ready(measuresAnswer([DONE_MEASURE])) }, { view: 'done' }) },
    { id: 'keys', label: 'Keyboard shortcuts (?)', model: base('safety', { keysOpen: true }) },
  ],
})
