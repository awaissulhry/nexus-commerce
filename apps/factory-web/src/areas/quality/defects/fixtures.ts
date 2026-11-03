import { createElement, useEffect, useState } from 'react'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { inShell, NOW, type RoleCase } from '../_shared/fixtures'
import type { Dispositions, Library } from './api'
import { DISPOSITIONS, DISPOSITIONS_EMPTY, DISPOSITIONS_NO_COST, DISPOSITIONS_STANDARD, LEATHER, LIBRARY, LIBRARY_EMPTY, LIBRARY_STARTER, PICTURE_ID, PICTURE_SRC, SAFETY, SEAMS } from './demo/fixtures'
import { CAUSES, CAUSES_EMPTY, CAUSES_FULL, COVERAGE, GRADES, GRADES_EMPTY, SEVERITY } from './demo/vocabulary'
import { NEW_CAUSE, NEW_GRADE, newCauseProblems, newGradeProblems } from './vocabulary'
import {
  EMPTY_PICTURE,
  markKey,
  NEW_DEFECT,
  NEW_DISPOSITION,
  newDefectProblems,
  newDispositionProblems,
  withOutcome,
  type Address,
  type DefectsDialog,
  type DefectsModel,
} from './model'
import { DefectsView } from './view/DefectsView'

/**
 * SCR-079 Quality › Settings › Defects & dispositions — made-up data only (DEMO-… codes). Each case is a state the Owner
 * reviews: the library tree, a cell saving and refused, retire of a used code, delete held, the drawer (picture, zone on
 * the garment map, stages, upload under way), Add defect with its problems, the dispositions with the stock action in
 * words and the approval rule (the amount only with the cost grain), Add disposition, the starter and standard offers,
 * the W2b tabs (B-W2b-118: severity, causes, leather grades and hide defects), offline, live updates, and the role cases. In the browser the address, ticks, drawer and dialogs work
 * for real (the wrapper keeps them).
 */

interface DesignModel {
  readonly role: RoleCase
  readonly model: DefectsModel
}

/** The role cases: what each role's template holds (factory-domain). The owner holds the cost grain too. */
const ROLE_TEMPLATE: Readonly<Record<RoleCase, string>> = {
  owner: 'owner',
  inspector: 'quality_inspector',
  production: 'production_manager',
  supervisor: 'floor_supervisor',
  warehouse: 'warehouse',
  readOnly: 'read_only',
  sales: 'sales',
}
const held = (role: RoleCase) => new Set(templateOf(ROLE_TEMPLATE[role])?.permissions ?? [])
const manages = (role: RoleCase) => held(role).has('quality.defects.manage')

const address = (over: Partial<Address> = {}): Address => ({ tab: 'defects', view: 'all', q: '', open: null, isNew: false, ...over })

const page = (over: Partial<DefectsModel> = {}, role: RoleCase = 'owner'): DesignModel => {
  const can = manages(role)
  const permissions = held(role)
  const library: Library = { ...LIBRARY, canManage: can }
  const dispositions: Dispositions = { ...(role === 'owner' ? DISPOSITIONS : DISPOSITIONS_NO_COST), canManage: can }
  return {
    role,
    model: {
      prefix: '/w/DEMO',
      canView: permissions.has('quality.defects.view'),
      canUpload: permissions.has('files.upload'),
      seesCost: role === 'owner',
      address: address(),
      library: { value: library, problem: null },
      dispositions: { value: dispositions, problem: null },
      selected: [],
      marks: {},
      asOf: NOW,
      live: 'live',
      updates: 0,
      busy: false,
      notice: null,
      dialog: null,
      picture: EMPTY_PICTURE,
      thumbs: { [PICTURE_ID]: PICTURE_SRC },
      // B-W2b-118: the W2b tabs' reads.
      vocab: { severity: { value: SEVERITY, problem: null }, causes: { value: { ...CAUSES, canManage: can }, problem: null }, grades: { value: { ...GRADES, canManage: can }, problem: null }, coverage: COVERAGE },
      ...over,
    },
  }
}

const tabDisp = (over: Partial<DefectsModel> = {}, role: RoleCase = 'owner') => page({ address: address({ tab: 'dispositions' }), ...over }, role)
// B-W2b-118: the W2b tabs.
const tab = (name: 'severity' | 'causes' | 'grades', over: Partial<DefectsModel> = {}, role: RoleCase = 'owner') => page({ address: address({ tab: name }), ...over }, role)
const vocabWith = (role: RoleCase, change: Partial<NonNullable<DefectsModel['vocab']>>) => ({ ...page({}, role).model.vocab!, ...change })
const newCause = (draft = NEW_CAUSE, shown = false, problem: string | null = null): DefectsDialog => ({ kind: 'new-cause', draft, problems: newCauseProblems(draft, CAUSES.causes.map((row) => row.code)), problem, shown })
const newGrade = (draft = NEW_GRADE, shown = false): DefectsDialog => ({ kind: 'new-grade', draft, problems: newGradeProblems(draft, GRADES.grades.map((row) => row.code)), problem: null, shown })

const newDefect = (draft = NEW_DEFECT, shown = false, problem: string | null = null): DefectsDialog => ({ kind: 'new-defect', draft, problems: newDefectProblems(draft, LIBRARY), problem, shown })
const newDisposition = (draft = NEW_DISPOSITION, shown = false): DefectsDialog => ({ kind: 'new-disposition', draft, problems: newDispositionProblems(draft, DISPOSITIONS.dispositions.map((row) => row.code), true), problem: null, shown })

const OPEN_SEAM = SEAMS.defects[0]!

function DefectsDesign({ model: design }: { model: DesignModel }) {
  const [current, setCurrent] = useState<DefectsModel>(design.model)
  useEffect(() => setCurrent(design.model), [design])
  const set = (change: Partial<DefectsModel>) => setCurrent((model) => ({ ...model, ...change }))
  return inShell(
    '/quality/defects',
    createElement(DefectsView, {
      model: current,
      actions: {
        onAddress: (change) => set({ address: { ...current.address, ...change } }),
        onSelect: (ids) => set({ selected: [...ids] }),
        onDialog: (dialog) => set({ dialog }),
        onNewDefect: (parentId) => set({ dialog: newDefect({ ...NEW_DEFECT, parentId: parentId ?? null }) }),
        onNewDisposition: () => set({ dialog: newDisposition() }),
        onDefectDraft: (draft) => current.dialog?.kind === 'new-defect' && set({ dialog: { ...current.dialog, draft, problems: newDefectProblems(draft, current.library.value) } }),
        onDispositionDraft: (draft) => current.dialog?.kind === 'new-disposition' && set({ dialog: { ...current.dialog, draft, problems: newDispositionProblems(draft, [], current.seesCost) } }),
        onRetire: (ids) => set({ dialog: { kind: 'retire', ids } }),
        onNewCause: () => set({ dialog: newCause() }),
        onNewGrade: () => set({ dialog: newGrade() }),
        onCauseDraft: (draft) => current.dialog?.kind === 'new-cause' && set({ dialog: { ...current.dialog, draft, problems: newCauseProblems(draft, CAUSES.causes.map((row) => row.code)) } }),
        onGradeDraft: (draft) => current.dialog?.kind === 'new-grade' && set({ dialog: { ...current.dialog, draft, problems: newGradeProblems(draft, GRADES.grades.map((row) => row.code)) } }),
        onDeleteCause: (id) => set({ dialog: { kind: 'delete-cause', id } }),
        onDelete: (id) => set({ dialog: { kind: 'delete', id } }),
        onDismissNotice: () => set({ notice: null }),
      },
    }),
    design.role,
  )
}

export const designScreen = defineDesignScreen<DesignModel>({
  screen: 'SCR-079',
  title: 'Defect library and dispositions',
  view: DefectsDesign,
  cases: [
    { id: 'library', label: 'Owner: the defect library as a tree (category › defect), every cell autosaved', model: page(), note: 'Retired codes show with their pill; the footer icon holds the keys.' },
    { id: 'library-active', label: 'Rows: active codes only', model: page({ address: address({ view: 'active' }) }) },
    { id: 'library-search', label: 'Search "seam": the category and its defects', model: page({ address: address({ q: 'seam' }) }) },
    { id: 'filtered-empty', label: 'A search with nothing in it', model: page({ address: address({ q: 'zzz' }) }) },
    {
      id: 'cell-saving',
      label: 'Cells saving, saved, refused (with why) and unknown',
      model: page({
        marks: {
          [markKey(OPEN_SEAM.id, 'labelEn')]: { state: 'saving' },
          [markKey(SEAMS.defects[1]!.id, 'severity')]: { state: 'refused', problem: 'problem.stale' },
          [markKey(LEATHER.defects[0]!.id, 'labelIt')]: { state: 'unknown', problem: 'problem.offline' },
          [markKey(SAFETY.defects[0]!.id, 'active')]: { state: 'saved' },
        },
      }),
    },
    { id: 'selection', label: 'Selection: Retire 2 · Restore held (none retired) · Export 2', model: page({ selected: [OPEN_SEAM.id, SEAMS.defects[1]!.id] }) },
    { id: 'retire-used', label: 'Retire a used code: it stays on its 214 records and leaves the pickers', model: page({ dialog: { kind: 'retire', ids: [OPEN_SEAM.id] } }) },
    { id: 'retire-many', label: 'Retire a category, a used and an unused code at once', model: page({ dialog: { kind: 'retire', ids: [SEAMS.id, SEAMS.defects[1]!.id, SEAMS.defects[2]!.id] } }) },
    { id: 'retired-notice', label: 'Retire done with one refusal named', model: page({ notice: { key: 'done.retired', params: { count: 1 }, tone: 'warning', refused: [{ code: 'DEMO-PUCKER', key: 'problem.stale' }] } }) },
    { id: 'delete', label: 'Delete an unused code (never undone)', model: page({ dialog: { kind: 'delete', id: SEAMS.defects[2]!.id } }), note: 'A used code or a category with defects: Delete is held in the row menu with the reason.' },
    { id: 'drawer', label: 'Drawer: a defect with its picture, words, icon, class, zone on the garment map, stages', model: page({ address: address({ open: OPEN_SEAM.id }) }) },
    { id: 'drawer-no-picture', label: 'Drawer: no picture yet (upload or take a photo)', model: page({ address: address({ open: SEAMS.defects[1]!.id }) }) },
    { id: 'drawer-uploading', label: 'Drawer: the picture uploading', model: page({ address: address({ open: SEAMS.defects[1]!.id }), picture: { uploading: true, problem: null } }) },
    { id: 'drawer-upload-failed', label: 'Drawer: the upload failed (said, try again)', model: page({ address: address({ open: SEAMS.defects[1]!.id }), picture: { uploading: false, problem: 'picture.failed' } }) },
    { id: 'drawer-languages', label: 'Drawer: a code with words in another floor language (Romanian)', model: page({ address: address({ open: LEATHER.defects[0]!.id }) }) },
    { id: 'drawer-category', label: 'Drawer: a category (no class, no zone, no note)', model: page({ address: address({ open: SAFETY.id }) }) },
    { id: 'drawer-missing', label: 'Drawer: the address names a code the library does not hold', model: page({ address: address({ open: '0190f0e2-7901-7000-8000-999999999999' }) }) },
    { id: 'photo', label: 'Take a photo of the defect (DS photo capture, markup on)', model: page({ address: address({ open: SEAMS.defects[1]!.id }), dialog: { kind: 'photo', id: SEAMS.defects[1]!.id } }) },
    { id: 'new-defect', label: 'Add defect: empty (Add held with the first problem)', model: page({ dialog: newDefect() }) },
    {
      id: 'new-defect-problems',
      label: 'Add defect: problems at their fields after a try',
      model: page({ dialog: newDefect({ ...NEW_DEFECT, parentId: SEAMS.id, code: 'DEMO-SEAM-OPEN', labelIt: 'Cucitura aperta', labelEn: '' }, true) }),
    },
    {
      id: 'new-defect-ready',
      label: 'Add defect: ready, with a zone and stages',
      model: page({ dialog: newDefect({ ...NEW_DEFECT, parentId: SEAMS.id, code: 'DEMO-SEAM-WAVY', labelIt: 'Cucitura ondulata', labelEn: 'Wavy seam', zone: 'BACK', stages: ['IN_LINE', 'FINAL'] }) }),
    },
    { id: 'new-category', label: 'Add a category', model: page({ dialog: newDefect({ ...NEW_DEFECT, kind: 'category', code: 'DEMO-HARDWARE', labelIt: 'Accessori', labelEn: 'Hardware' }) }) },
    { id: 'new-refused', label: 'Add defect refused by the API (the library is full)', model: page({ dialog: newDefect({ ...NEW_DEFECT, parentId: SEAMS.id, code: 'DEMO-NEW', labelIt: 'Nuovo', labelEn: 'New' }, true, 'problem.libraryFull') }) },
    { id: 'starter', label: 'Starter set offered (6 codes missing)', model: page({ library: { value: LIBRARY_STARTER, problem: null } }) },
    { id: 'empty', label: 'First day: no codes yet (start from the starter set)', model: page({ library: { value: LIBRARY_EMPTY, problem: null } }) },
    { id: 'dispositions', label: 'Dispositions: each code, its stock action in words, re-inspection, approval (class and value)', model: tabDisp() },
    { id: 'dispositions-selection', label: 'Dispositions: Set 2 inactive · Export 2', model: tabDisp({ selected: [DISPOSITIONS.dispositions[0]!.id, DISPOSITIONS.dispositions[1]!.id] }) },
    { id: 'dispositions-standard', label: 'Dispositions: the standard codes offered (2 missing)', model: tabDisp({ dispositions: { value: DISPOSITIONS_STANDARD, problem: null } }) },
    { id: 'dispositions-empty', label: 'Dispositions: none yet (add the 7 standard codes)', model: tabDisp({ dispositions: { value: DISPOSITIONS_EMPTY, problem: null } }) },
    { id: 'dispositions-no-cost', label: 'Dispositions for a person without cost access: the amount rule hidden', model: tabDisp({ seesCost: false, dispositions: { value: DISPOSITIONS_NO_COST, problem: null } }, 'inspector') },
    { id: 'new-disposition', label: 'Add disposition: pick what it decides first', model: tabDisp({ dialog: newDisposition() }) },
    {
      id: 'new-disposition-return',
      label: 'Add disposition: return to the supplier — its moves and follow-ups, the approval rule',
      model: tabDisp({ dialog: newDisposition({ ...withOutcome(NEW_DISPOSITION, 'RETURN_TO_SUPPLIER', DISPOSITIONS.outcomes), code: 'DEMO_RETURN_CLAIM', labelIt: 'Reso con reclamo', labelEn: 'Return with a claim', approvalSeverity: 'MAJOR', approvalAmount: '250,00' }) }),
    },
    { id: 'new-disposition-problems', label: 'Add disposition: problems after a try (code taken, words missing)', model: tabDisp({ dialog: newDisposition({ ...withOutcome(NEW_DISPOSITION, 'SCRAP', DISPOSITIONS.outcomes), code: 'DEMO_SCRAP' }, true) }) },
    { id: 'live-updates', label: 'Live: 2 updates waiting behind Show', model: page({ updates: 2 }) },
    { id: 'offline', label: 'Offline: the last copy with its time', model: page({ live: 'offline' }) },
    { id: 'keyboard', label: 'Keyboard: a focused row (Enter opens its drawer)', model: page({ focusRow: 3 }) },
    { id: 'keys', label: 'The keys dialog', model: page({ dialog: { kind: 'keys' } }) },
    { id: 'inspector', label: 'Quality inspector: manages the library (no cost access)', model: page({ seesCost: false }, 'inspector') },
    { id: 'production', label: 'Production manager: reads the library; every change held with its reason', model: page({}, 'production') },
    { id: 'supervisor', label: 'Floor supervisor: reads, opens a drawer read-only', model: page({ address: address({ open: OPEN_SEAM.id }) }, 'supervisor') },
    { id: 'read-only', label: 'Read-only: reads both tabs, changes nothing', model: tabDisp({ seesCost: false }, 'readOnly') },
    { id: 'no-permission', label: 'Sales: no permission (which permission, who grants it)', model: page({}, 'sales') },
    { id: 'loading', label: 'Loading', model: page({ library: { value: null, problem: null }, dispositions: { value: null, problem: null }, asOf: null, live: 'connecting' }) },
    { id: 'error', label: "The API didn't answer (never an empty library)", model: page({ library: { value: null, problem: 'problem.offline' }, dispositions: { value: null, problem: 'problem.offline' }, asOf: null, live: 'offline' }) },
    { id: 'dispositions-error', label: 'Dispositions could not be read', model: tabDisp({ dispositions: { value: null, problem: 'problem.read' } }) },
    // B-W2b-118: Severity, Causes, Leather grades.
    { id: 'severity', label: 'Severity: critical, major, minor; the critical class locked with its law', model: tab('severity') },
    { id: 'severity-loading', label: 'Severity loading', model: tab('severity', { vocab: vocabWith('owner', { severity: { value: null, problem: null } }) }) },
    { id: 'causes', label: 'Causes: each code with its words (Italian, English, Romanian), its process, how often used; 2 starter codes missing; Romanian words missing on 2', model: tab('causes') },
    {
      id: 'causes-cells',
      label: 'Causes: cells saving, refused (with why) and unknown',
      model: tab('causes', { marks: { [markKey(CAUSES.causes[0]!.id, 'labelEn')]: { state: 'saving' }, [markKey(CAUSES.causes[1]!.id, 'lang:ro')]: { state: 'refused', problem: 'problem.tooLong' }, [markKey(CAUSES.causes[3]!.id, 'active')]: { state: 'unknown', problem: 'problem.offline' } } }),
    },
    { id: 'causes-selected', label: 'Causes: two ticked (Retire 2 · Restore held · Export 2)', model: tab('causes', { selected: [CAUSES.causes[0]!.id, CAUSES.causes[1]!.id] }) },
    { id: 'causes-complete', label: 'Causes: every starter code there', model: tab('causes', { vocab: vocabWith('owner', { causes: { value: CAUSES_FULL, problem: null }, coverage: null }) }) },
    { id: 'causes-empty', label: 'Causes: none yet (start from the 8 starter codes)', model: tab('causes', { vocab: vocabWith('owner', { causes: { value: CAUSES_EMPTY, problem: null }, coverage: null }) }) },
    { id: 'causes-new', label: 'Add cause: empty (held with the first problem)', model: tab('causes', { dialog: newCause() }) },
    { id: 'causes-new-problems', label: 'Add cause: problems at their fields (code taken, no process)', model: tab('causes', { dialog: newCause({ ...NEW_CAUSE, code: 'DEMO-SEW', labelIt: 'Cucitura storta', labelEn: '' }, true) }) },
    { id: 'causes-new-ready', label: 'Add cause: ready', model: tab('causes', { dialog: newCause({ code: 'DEMO-GLUE', process: 'FINISHING', labelIt: 'Colla in eccesso (demo)', labelEn: 'Too much glue (demo)' }) }) },
    { id: 'causes-delete', label: 'Delete an unused cause (never undone)', model: tab('causes', { dialog: { kind: 'delete-cause', id: CAUSES.causes[4]!.id } }) },
    { id: 'causes-read-only', label: 'Production manager: reads the causes, every change held with why', model: tab('causes', {}, 'production') },
    { id: 'causes-error', label: 'Causes could not be read', model: tab('causes', { vocab: vocabWith('owner', { causes: { value: null, problem: 'problem.offline' } }) }) },
    { id: 'grades', label: 'Leather grades A–D with the usable share, D retired; the hide defects with their icons', model: tab('grades') },
    { id: 'grades-cells', label: 'Leather grades: a share saved, a share refused (120 %)', model: tab('grades', { marks: { [markKey(GRADES.grades[1]!.id, 'usableShare')]: { state: 'refused', problem: 'problem.usableShare' }, [markKey(GRADES.grades[2]!.id, 'usableShare')]: { state: 'saving' } } }) },
    { id: 'grades-new', label: 'Add grade: code, words, usable share', model: tab('grades', { dialog: newGrade({ code: 'E', labelIt: 'Scarto (demo)', labelEn: 'Reject (demo)', usableShare: '30' }) }) },
    { id: 'grades-new-problems', label: 'Add grade: problems (code taken, a share of 120)', model: tab('grades', { dialog: newGrade({ code: 'A', labelIt: 'Prima', labelEn: 'First', usableShare: '120' }, true) }) },
    { id: 'grades-empty', label: 'Leather grades: none yet, no LEATHER category in the library', model: tab('grades', { vocab: vocabWith('owner', { grades: { value: GRADES_EMPTY, problem: null }, coverage: null }) }) },
    { id: 'grades-read-only', label: 'Floor supervisor: reads the grades and the hide defects', model: tab('grades', {}, 'supervisor') },
  ],
})
