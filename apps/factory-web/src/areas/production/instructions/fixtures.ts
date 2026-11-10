import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { ARCHIVED_ROWS, canFor, inShell, NOW, PREFIX, ROWS, type RoleCase } from './demo/fixtures'
import { EMPTY_NEW, rowsOfView, tileCounts, type ListAddress } from './model'
import { InstructionsListView, type InstructionsListModel, type NewInstructionModel } from './view/InstructionsListView'

/**
 * SCR-141 — Work instructions (design production.instructions, workspace-list), made-up data only. Cases: the list as the
 * production manager sees it, each saved view (drafts waiting, a floor language missing, never published, archived), a
 * search with no match, rows selected (Export N, Archive N), Archive N, New instruction (empty, for one style revision, a
 * refusal), Bring in typed steps (the dry run, done), empty (a writer, a reader), loading, a failed read, the role cases
 * (floor supervisor, quality, HR, read-only, sales: no access).
 */

interface DesignModel {
  readonly role: RoleCase
  readonly model: InstructionsListModel
}

const address = (over: Partial<ListAddress> = {}): ListAddress => ({ view: 'active', q: '', creating: false, typed: false, ...over })
const list = { instructions: ROWS, truncated: false, counts: { active: ROWS.length, archived: ARCHIVED_ROWS.length, drafts: 2 }, canManage: true }

function page(over: Partial<InstructionsListModel> = {}, role: RoleCase = 'manager'): DesignModel {
  const view = over.address?.view ?? 'active'
  return {
    role,
    model: {
      prefix: PREFIX,
      can: canFor(role),
      address: address(),
      rows: { items: view === 'archived' ? ARCHIVED_ROWS : rowsOfView(ROWS, view), truncated: false, problem: null },
      tiles: tileCounts(list),
      asOf: NOW,
      updates: 0,
      busy: false,
      notice: null,
      creating: null,
      typed: null,
      ...over,
    },
  }
}

const OPERATIONS = [
  { id: '0190f0e2-4901-7000-8000-000000000002', companyId: null, code: 'DEMO-CUC-SPALLA', name: 'Cucitura spalla', nameI18n: { it: 'Cucitura spalla', en: 'Sew shoulder seam' }, workCentreKind: 'SEWING', machineType: 'Piana 1 ago', skill: 'Cucitrice', standardMinutes: '6.2', status: 'ACTIVE', usedIn: 5, differing: 0, version: 2, updatedAt: NOW },
  { id: '0190f0e2-4901-7000-8000-000000000005', companyId: null, code: 'DEMO-RIF-BORDI', name: 'Rifinitura bordi', nameI18n: null, workCentreKind: 'FINISHING', machineType: 'Pressa', skill: null, standardMinutes: '4', status: 'ACTIVE', usedIn: 0, differing: 0, version: 1, updatedAt: NOW },
] as unknown as NonNullable<NewInstructionModel['operations']['items']>

const creating = (over: Partial<NewInstructionModel> = {}): NewInstructionModel => ({
  draft: EMPTY_NEW,
  operations: { items: OPERATIONS, problem: null },
  styles: null,
  revisions: null,
  copies: ROWS.filter((row) => row.current !== null),
  busy: false,
  problem: null,
  ...over,
})

const TYPED = {
  rows: [
    {
      routingOperationId: '0190f0e2-5501-7000-8000-000000000001',
      style: { id: '0190f0e2-7777-7000-8000-000000000001', code: 'DEMO-JKT-01', name: 'Giacca pelle demo' },
      revision: { id: '0190f0e2-7878-7000-8000-000000000003', revision: 3, status: 'RELEASED' },
      step: { seq: 60, code: 'DEMO-CQ-FINALE', operationId: '0190f0e2-4901-7000-8000-000000000006' },
      steps: [
        { code: 'SEAMS_OK', words: 'Cuciture dritte e chiuse', requiredTick: true },
        { code: 'LINT', words: 'Togli i fili', requiredTick: false },
      ],
      existing: null,
    },
    {
      routingOperationId: '0190f0e2-5501-7000-8000-000000000002',
      style: { id: '0190f0e2-7777-7000-8000-000000000002', code: 'DEMO-JKT-02', name: 'Giacca tessuto demo' },
      revision: { id: '0190f0e2-7878-7000-8000-000000000009', revision: 1, status: 'RELEASED' },
      step: { seq: 30, code: 'DEMO-CUC-ZIP', operationId: '0190f0e2-4901-7000-8000-000000000003' },
      steps: [{ code: 'ZIP_GUARD', words: 'Copri la cerniera con la patta', requiredTick: true }],
      existing: { id: '0190f0e2-5401-7000-8000-000000000003', number: 'WI-2026-0003', status: 'ACTIVE' },
    },
  ],
  toMake: 1,
  made: 0,
}

function ListDesign({ model }: { model: DesignModel }) {
  return inShell('/production/instructions', createElement(InstructionsListView, { model: model.model }), model.role)
}

export const designScreen = defineDesignScreen<DesignModel>({
  screen: 'SCR-141',
  title: 'Work instructions',
  view: ListDesign,
  cases: [
    { id: 'normal', label: 'In use (production manager)', model: page(), note: 'The list frame: operation, styles where used, languages with the missing ones marked, version, status, media, a count of who saw it (never names), last changed.' },
    { id: 'drafts', label: 'Drafts waiting', model: page({ address: address({ view: 'drafts' }) }), note: 'The tile is pressed; a chip says the view.' },
    { id: 'missing', label: 'Floor language missing', model: page({ address: address({ view: 'missing' }) }) },
    { id: 'unpublished', label: 'Never published', model: page({ address: address({ view: 'unpublished' }) }) },
    { id: 'archived', label: 'Archived', model: page({ address: address({ view: 'archived' }) }) },
    { id: 'no-match', label: 'Search, no match', model: page({ address: address({ q: 'tasca' }), rows: { items: [], truncated: false, problem: null } }), note: '"No rows match these filters" + Clear filters.' },
    { id: 'selected', label: 'Rows selected', model: page({ selected: [ROWS[1]!.id, ROWS[2]!.id] }), note: 'The toolbar swaps to Export 2 and Archive 2.' },
    { id: 'archive-dialog', label: 'Archive 2', model: page({ selected: [ROWS[1]!.id, ROWS[2]!.id], dialog: 'archive' }), note: 'What it does on the floor, a reason kept with it.' },
    { id: 'new', label: 'New instruction', model: page({ creating: creating() }), note: 'The operation, every style or one revision, blank or a copy; made with version 1 as a draft.' },
    { id: 'new-revision', label: 'New instruction: one revision', model: page({ creating: creating({ draft: { ...EMPTY_NEW, operationId: OPERATIONS[0]!.id, scope: 'revision', styleId: '0190f0e2-7777-7000-8000-000000000001', revisionId: '' }, styles: { items: [{ id: '0190f0e2-7777-7000-8000-000000000001', code: 'DEMO-JKT-01', name: 'Giacca pelle demo' }], problem: null }, revisions: { items: [{ id: '0190f0e2-7878-7000-8000-000000000003', revision: 3, status: 'RELEASED' }, { id: '0190f0e2-7878-7000-8000-000000000002', revision: 2, status: 'OBSOLETE' }], problem: null } }) }), note: 'Make is held until the revision is chosen (held, with the reason).' },
    { id: 'new-refused', label: 'New instruction: refused', model: page({ creating: creating({ draft: { ...EMPTY_NEW, operationId: OPERATIONS[0]!.id }, problem: 'refusal.ACTIVE_EXISTS' }) }), note: 'The API\'s refusal said from its code.' },
    { id: 'typed', label: 'Bring in typed steps', model: page({ typed: { language: 'it', answer: TYPED, problem: null, busy: false, made: null } }), note: 'The dry run: what each routing step\'s typed lines give, the ones that have an instruction already.' },
    { id: 'typed-done', label: 'Typed steps brought in', model: page({ typed: { language: 'it', answer: { ...TYPED, rows: TYPED.rows.map((row) => ({ ...row, existing: row.existing ?? { id: '0190f0e2-5401-7000-8000-000000000010', number: 'WI-2026-0010', status: 'ACTIVE' } })), toMake: 0 }, problem: null, busy: false, made: 1 } }) },
    { id: 'empty', label: 'Empty (a writer)', model: page({ rows: { items: [], truncated: false, problem: null }, tiles: { active: 0, drafts: 0, missing: 0, unpublished: 0, archived: 0 } }), note: '"No instructions yet" with New instruction.' },
    { id: 'empty-reader', label: 'Empty (read-only)', model: page({ rows: { items: [], truncated: false, problem: null }, tiles: { active: 0, drafts: 0, missing: 0, unpublished: 0, archived: 0 } }, 'readOnly') },
    { id: 'loading', label: 'Loading', model: page({ rows: { items: null, truncated: false, problem: null }, asOf: null }) },
    { id: 'error', label: 'Could not read', model: page({ rows: { items: null, truncated: false, problem: 'problem.unavailable' } }), note: 'A failed read is never drawn as an empty list: Try again.' },
    { id: 'updates', label: 'Live: 3 updates', model: page({ updates: 3 }) },
    { id: 'supervisor', label: 'Floor supervisor (writes, never approves)', model: page({}, 'supervisor') },
    { id: 'quality', label: 'Quality (approves, never writes)', model: page({}, 'quality'), note: 'New instruction held with the reason.' },
    { id: 'hr', label: 'HR (reads; names only inside a record)', model: page({}, 'hr') },
    { id: 'no-permission', label: 'No access (sales)', model: page({ rows: { items: null, truncated: false, problem: 'problem.forbidden' } }, 'sales'), note: 'The page says which permission is missing.' },
  ],
})
