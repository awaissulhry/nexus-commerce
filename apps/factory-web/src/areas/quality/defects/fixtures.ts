import { createElement, useEffect, useState } from 'react'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { inShell, NOW, type RoleCase } from '../_shared/fixtures'
import type { Dispositions, Library } from './api'
import { DISPOSITIONS, DISPOSITIONS_EMPTY, DISPOSITIONS_NO_COST, DISPOSITIONS_STANDARD, LEATHER, LIBRARY, LIBRARY_EMPTY, LIBRARY_STARTER, PICTURE_ID, PICTURE_SRC, SAFETY, SEAMS } from './demo/fixtures'
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
 * the W2b tabs held, offline, live updates, and the role cases. In the browser the address, ticks, drawer and dialogs work
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
      ...over,
    },
  }
}

const tabDisp = (over: Partial<DefectsModel> = {}, role: RoleCase = 'owner') => page({ address: address({ tab: 'dispositions' }), ...over }, role)

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
  ],
})
