import { createElement, useEffect, useState } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { STEP_UP_CLOSED } from '../../quality/_shared/hooks'
import {
  ALERTS,
  COMPANY_ID,
  KINDS,
  LEATHER_TANNERY,
  MATERIALS,
  MESH_ONE,
  NOW,
  OLD_WORKSHOP,
  OWN_DEFAULT,
  PREFIX,
  readOnly,
  REMINDERS_ALL,
  REMINDERS_DEFAULT,
  REMINDERS_FOLLOW,
  REMINDERS_OWN_ON,
  RULES_NONE,
  RULES_OFF,
  RULES_ON,
  SUPPLIERS,
  SWITCH_AUDIT,
  TANNERY,
  TOLERANCE_AUDIT,
  TOLERANCES,
  TOLERANCES_FOLLOWING,
  ZIPS_EXACT,
} from './demo'
import type { ReminderSettings, Tolerance } from './api'
import {
  defaultDraftOf,
  failed,
  movable,
  NO_ADDRESS,
  ownDefaultOf,
  poRulesOf,
  ready,
  rulesChangedOf,
  switchChangedOf,
  toleranceDraftOf,
  tolerancesChangedOf,
  type Address,
  type ToleranceDraft,
} from './model'
import type { DialogState, PurchasingSettingsModel, SettingsCan } from './view-model'
import { PurchasingSettingsView } from './view/PurchasingSettingsView'

/**
 * SCR-256 Purchasing › Settings › Purchasing settings — made-up data only (DEMO- codes, "Demo" names). Each case is a state
 * the Owner reviews: this company and every company; PO approval with no rule switched on (the honest default), one on,
 * none written; the delivery tolerance default kept, followed, none (fields empty with a hint each), changed, held,
 * saving, saved, refused, changed elsewhere; the exceptions (ticked, archived, none) and the dialog (new, problems, the
 * same scope, edit, archived, refused); Confirmation with the Owner's switch (off by default, switched on: the warning and
 * "Confirm it's you", a wrong code), the buyer's alert (on, none); the role cases (the Owner, a buyer, a reader, a warehouse
 * person without approvals or alerts); loading, each read failed, offline, the keys, no permission. In the browser the
 * scope, the cards and the dialogs work (the wrapper keeps them); nothing is saved.
 */

type Role = 'owner' | 'buyer' | 'reader' | 'warehouse' | 'none'

const CAN: Record<Role, SettingsCan> = {
  owner: { view: true, approvals: true, rulesManage: true, tolerances: true, alerts: true, audit: true, suppliers: true, materials: true },
  buyer: { view: true, approvals: true, rulesManage: false, tolerances: true, alerts: true, audit: false, suppliers: true, materials: true },
  reader: { view: true, approvals: true, rulesManage: false, tolerances: false, alerts: false, audit: false, suppliers: true, materials: true },
  warehouse: { view: true, approvals: false, rulesManage: false, tolerances: false, alerts: false, audit: false, suppliers: false, materials: true },
  none: { view: false, approvals: false, rulesManage: false, tolerances: false, alerts: false, audit: false, suppliers: false, materials: false },
}

const address = (over: Partial<Address> = {}): Address => ({ ...NO_ADDRESS, ...over })

function page(over: Partial<PurchasingSettingsModel> = {}, role: Role = 'owner'): PurchasingSettingsModel {
  const can = CAN[role]
  const owner = role === 'owner'
  const rows = owner || role === 'buyer' ? TOLERANCES : readOnly(TOLERANCES)
  const reminders: ReminderSettings = { ...REMINDERS_DEFAULT, mayChange: owner }
  const scope = over.address?.scope ?? 'company'
  const tolerances = (over.tolerances?.value ?? rows) as Tolerance[]
  const settings = over.reminders?.value ?? reminders
  const rulesAnswer = over.rules?.value ?? RULES_OFF
  return {
    prefix: PREFIX,
    address: address(),
    companyId: COMPANY_ID,
    companyName: 'Demo Factory Srl',
    can,
    rules: can.approvals ? ready(RULES_OFF) : null,
    kinds: can.approvals ? ready(KINDS) : null,
    tolerances: ready(rows),
    defaultDraft: defaultDraftOf(ownDefaultOf(tolerances, scope, COMPANY_ID)),
    selected: [],
    dialog: null,
    suppliers: null,
    materials: null,
    reminders: ready(reminders),
    reminderDraft: settings.on,
    alerts: can.alerts ? ready(ALERTS) : null,
    changed: {
      approval: rulesChangedOf(poRulesOf(rulesAnswer, scope, COMPANY_ID)),
      tolerance: tolerancesChangedOf(tolerances, can.audit ? TOLERANCE_AUDIT : null),
      confirm: switchChangedOf(settings, scope, can.audit ? SWITCH_AUDIT : null),
    },
    busy: null,
    save: { kind: 'idle' },
    notice: null,
    live: 'live',
    asOf: NOW,
    changedElsewhere: false,
    keysOpen: false,
    stepUp: STEP_UP_CLOSED,
    ...over,
  }
}

const withRows = (rows: Tolerance[], over: Partial<PurchasingSettingsModel> = {}, role: Role = 'owner') => page({ tolerances: ready(rows), defaultDraft: defaultDraftOf(ownDefaultOf(rows, over.address?.scope ?? 'company', COMPANY_ID)), ...over }, role)
const dialog = (draft: ToleranceDraft, over: Partial<DialogState> = {}): DialogState => ({ draft, shown: false, problem: null, ...over })
const NEW = toleranceDraftOf(null, COMPANY_ID)
const pickers = { suppliers: ready(SUPPLIERS), materials: ready(MATERIALS) }
const ALL_ROWS = TOLERANCES.filter((row) => row.companyId === null)

function SettingsDesign({ model: design }: { model: PurchasingSettingsModel }) {
  const [current, setCurrent] = useState<PurchasingSettingsModel>(design)
  useEffect(() => setCurrent(design), [design])
  const set = (change: Partial<PurchasingSettingsModel>) => setCurrent((model) => ({ ...model, ...change }))
  const rows = current.tolerances.value ?? []
  const own = ownDefaultOf(rows, current.address.scope, current.companyId)
  return createElement(PurchasingSettingsView, {
    model: current,
    actions: {
      onScope: (scope) =>
        setCurrent(
          scope === 'all'
            ? withRows(ALL_ROWS, { address: address({ scope: 'all' }), reminders: ready(REMINDERS_ALL), reminderDraft: false, can: current.can })
            : { ...design, address: address(), can: current.can },
        ),
      onStatus: (status) => set({ address: { ...current.address, status }, selected: [] }),
      onOpenRule: () => set({ notice: { key: 'approval.inboxLink', tone: 'info' } }),
      onDefault: (defaultDraft) => set({ defaultDraft, save: { kind: 'unsaved', count: 1 } }),
      onDiscardDefault: () => set({ defaultDraft: defaultDraftOf(own), save: { kind: 'idle' } }),
      onApplyDefault: () => set({ notice: { key: 'done.default', tone: 'success' }, defaultDraft: defaultDraftOf(own), save: { kind: 'saved', at: NOW } }),
      onRemoveDefault: () => set({ notice: { key: 'done.defaultRemoved', tone: 'success' } }),
      onSelect: (ids) => set({ selected: [...ids] }),
      onToleranceOpen: (toleranceId) => set({ dialog: dialog(toleranceDraftOf(toleranceId === 'new' ? null : (rows.find((row) => row.id === toleranceId) ?? null), current.address.scope === 'company' ? COMPANY_ID : null)), ...pickers }),
      onDraft: (draft) => current.dialog && set({ dialog: { ...current.dialog, draft, problem: null } }),
      onDialogSave: () => current.dialog && set({ dialog: null, notice: { key: current.dialog.draft.id ? 'done.saved' : 'done.added', tone: 'success' } }),
      onDialogClose: () => set({ dialog: null }),
      onMove: (_row, to) => set({ dialog: null, notice: { key: to === 'archive' ? 'done.archived' : 'done.reactivated', tone: 'success', params: { count: 1 } } }),
      onBulkMove: (to) => set({ selected: [], notice: { key: to === 'archive' ? 'done.archived' : 'done.reactivated', tone: 'success', params: { count: movable(rows, current.selected, to).length } } }),
      onReminder: (on) => set({ reminderDraft: on }),
      onDiscardReminder: () => current.reminders.value && set({ reminderDraft: current.reminders.value.on }),
      onApplyReminder: () => set(current.reminderDraft ? { stepUp: { open: true, busy: false, sentence: 'stepUp.sentence', problem: null } } : { notice: { key: 'done.remindersOff', tone: 'success' } }),
      onStepUpSubmit: () => set({ stepUp: STEP_UP_CLOSED, notice: { key: 'done.remindersOn', tone: 'success' }, reminders: ready(REMINDERS_OWN_ON), reminderDraft: true }),
      onStepUpCancel: () => set({ stepUp: STEP_UP_CLOSED, notice: { key: 'stepUp.cancelled', tone: 'warning' } }),
      onDismissNotice: () => set({ notice: null }),
      onKeys: () => set({ keysOpen: true }),
      onKeysClose: () => set({ keysOpen: false }),
    },
  })
}

const STEP_UP_OPEN = { open: true, busy: false, sentence: 'stepUp.sentence', problem: null }

export const designScreen = defineDesignScreen<PurchasingSettingsModel>({
  screen: 'SCR-256',
  title: 'Purchasing settings',
  view: SettingsDesign,
  cases: [
    { id: 'owner', label: 'Owner, this company: PO approval with no rule switched on, the tolerance default and its exceptions, reminders off (never switched on), the buyer alert', model: page(), note: 'Nobody approves their own request, the Owner included; no rule is on until the Owner switches one on in Admin › Approvals, automation & AI.' },
    { id: 'rules-on', label: 'PO approval: one rule switched on (signed with a code), asked 4 times in 30 days', model: page({ rules: ready(RULES_ON) }) },
    { id: 'rules-none', label: 'PO approval: no rule written yet (every order is sent without a yes)', model: page({ rules: ready(RULES_NONE), changed: { approval: null, tolerance: tolerancesChangedOf(TOLERANCES, TOLERANCE_AUDIT), confirm: null } }) },
    { id: 'all', label: 'Every company: the rules and defaults every company follows; the reminders of every company', model: withRows(ALL_ROWS, { address: address({ scope: 'all' }), reminders: ready(REMINDERS_ALL), reminderDraft: false }) },
    { id: 'following', label: 'A company that keeps no default of its own: it follows every company’s (+2 % / −2 %); reminders follow every company', model: withRows(TOLERANCES_FOLLOWING, { reminders: ready(REMINDERS_FOLLOW), reminderDraft: false }) },
    { id: 'default-empty', label: 'No default anywhere: the fields start empty with a hint each; exactly as ordered applies', model: withRows([LEATHER_TANNERY], { changed: { approval: null, tolerance: null, confirm: null } }) },
    { id: 'default-changed', label: 'The default changed: over 6 %, beyond needs a yes (EditModeBar, ⌘S)', model: page({ defaultDraft: { over: 6, under: 3, whenBeyond: 'APPROVAL' }, save: { kind: 'unsaved', count: 1 } }) },
    { id: 'default-new', label: 'A first default typed (over only: under held with why)', model: withRows(TOLERANCES_FOLLOWING.filter((row) => row.companyId !== null), { defaultDraft: { over: 5, under: '', whenBeyond: 'BLOCK' }, save: { kind: 'unsaved', count: 1 } }) },
    { id: 'default-problem', label: 'The default held: 120 % is not a percentage', model: page({ defaultDraft: { over: 120, under: 3, whenBeyond: 'BLOCK' }, save: { kind: 'unsaved', count: 1 } }) },
    { id: 'saving', label: 'Saving the default (the bar busy, every change held)', model: page({ defaultDraft: { over: 6, under: 3, whenBeyond: 'BLOCK' }, busy: 'default', save: { kind: 'saving' } }) },
    { id: 'saved', label: 'Saved', model: page({ notice: { key: 'done.default', tone: 'success' }, save: { kind: 'saved', at: NOW } }) },
    { id: 'stale', label: 'Refused: someone changed the default meanwhile (read again, nothing overwritten)', model: page({ notice: { key: 'problem.write.moved', tone: 'danger' }, save: { kind: 'failed', count: 1 } }) },
    { id: 'changed-elsewhere', label: 'Live: changed on another screen while this one holds a change', model: page({ defaultDraft: { over: 6, under: 3, whenBeyond: 'BLOCK' }, changedElsewhere: true, save: { kind: 'unsaved', count: 1 } }) },
    { id: 'selected', label: 'Exceptions: two ticked (Archive 2 · Reactivate held: none archived)', model: page({ selected: [LEATHER_TANNERY.id, ZIPS_EXACT.id] }) },
    { id: 'archived', label: 'Exceptions: the archived ones (Reactivate)', model: page({ address: address({ status: 'ARCHIVED' }), selected: [OLD_WORKSHOP.id] }) },
    { id: 'exceptions-empty', label: 'Exceptions: none yet', model: withRows([OWN_DEFAULT]) },
    { id: 'dialog-new', label: 'New delivery tolerance: for, supplier, material (a kind or one), over, under, beyond, note', model: page({ dialog: dialog({ ...NEW, supplierId: TANNERY.id, materialMode: 'KIND', itemKind: 'LINING' }), address: address({ tolerance: 'new' }), ...pickers }) },
    { id: 'dialog-problems', label: 'New delivery tolerance with problems at its fields (no supplier and no material; no percentages)', model: page({ dialog: dialog(NEW, { shown: true }), address: address({ tolerance: 'new' }), ...pickers }) },
    { id: 'dialog-same-scope', label: 'New delivery tolerance for a supplier and kind that has an active rule (said before Save)', model: page({ dialog: dialog({ ...NEW, supplierId: TANNERY.id, materialMode: 'KIND', itemKind: 'LEATHER', over: 6, under: 4 }), address: address({ tolerance: 'new' }), ...pickers }) },
    { id: 'dialog-edit', label: 'A rule opened: its scope as text (it never changes), its figures, beyond and note; Archive', model: page({ dialog: dialog(toleranceDraftOf(MESH_ONE, COMPANY_ID)), address: address({ tolerance: MESH_ONE.id }) }) },
    { id: 'dialog-archived', label: 'An archived rule: as text, Reactivate', model: page({ dialog: dialog(toleranceDraftOf(OLD_WORKSHOP, COMPANY_ID)), address: address({ status: 'ALL', tolerance: OLD_WORKSHOP.id }) }) },
    { id: 'dialog-refused', label: 'Refused by the API: the same scope was added meanwhile', model: page({ dialog: dialog({ ...NEW, supplierId: TANNERY.id, materialMode: 'KIND', itemKind: 'LINING', over: 4, under: 4 }, { shown: true, problem: { key: 'problem.write.sameScope', reload: true, fields: {} } }), address: address({ tolerance: 'new' }), ...pickers }) },
    { id: 'dialog-pickers-loading', label: 'New delivery tolerance while the suppliers and materials are read', model: page({ dialog: dialog({ ...NEW, materialMode: 'ITEM' }), address: address({ tolerance: 'new' }), suppliers: { value: null, problem: null }, materials: { value: null, problem: null } }) },
    { id: 'switch-on', label: 'Confirmation: the Owner switches reminders on (the warning; Save asks for a code)', model: page({ reminderDraft: true, save: { kind: 'unsaved', count: 1 } }) },
    { id: 'step-up', label: 'Confirm it’s you: a fresh 6-digit code before reminders are switched on', model: page({ reminderDraft: true, busy: 'reminders', stepUp: STEP_UP_OPEN }) },
    { id: 'step-up-wrong', label: 'Confirm it’s you: a wrong code (said in the dialog)', model: page({ reminderDraft: true, busy: 'reminders', stepUp: { ...STEP_UP_OPEN, problem: 'stepUp.problem.wrong' } }) },
    { id: 'switch-done', label: 'Reminders switched on for this company (who and when)', model: page({ reminders: ready(REMINDERS_OWN_ON), reminderDraft: true, notice: { key: 'done.remindersOn', tone: 'success' }, changed: { approval: rulesChangedOf(poRulesOf(RULES_OFF, 'company', COMPANY_ID)), tolerance: tolerancesChangedOf(TOLERANCES, TOLERANCE_AUDIT), confirm: switchChangedOf(REMINDERS_OWN_ON, 'company', SWITCH_AUDIT) } }) },
    { id: 'alert-none', label: 'Confirmation: no buyer alert rule (the buyer is not told)', model: page({ alerts: ready({ rules: [], canAdd: true }) }) },
    { id: 'buyer', label: 'Buyer: keeps the tolerances; reads the approval rules (New PO rule held), the switch is the Owner’s (view only)', model: page({}, 'buyer') },
    { id: 'reader', label: 'A reader (purchasing.view + approvals.view): everything as text, every change held with why', model: page({}, 'reader') },
    { id: 'warehouse', label: 'Warehouse: no approvals.view and no alerts.view (said in words), tolerances as text', model: page({}, 'warehouse') },
    { id: 'no-permission', label: 'No permission (which permission, who grants it)', model: page({}, 'none') },
    { id: 'loading', label: 'Loading (each card its skeleton)', model: page({ rules: { value: null, problem: null }, kinds: { value: null, problem: null }, tolerances: { value: null, problem: null }, defaultDraft: null, reminders: { value: null, problem: null }, reminderDraft: null, alerts: { value: null, problem: null }, asOf: null, live: 'connecting', changed: { approval: null, tolerance: null, confirm: null } }) },
    { id: 'error', label: 'Every read failed: each card its words and Try again (never drawn as empty)', model: page({ rules: failed('problem.read.unavailable'), tolerances: failed('problem.read.internal'), defaultDraft: null, reminders: failed('problem.read.unavailable'), reminderDraft: null, alerts: failed('problem.read.unavailable'), changed: { approval: null, tolerance: null, confirm: null } }) },
    { id: 'offline', label: 'Offline: the last copy, every change held (kept on this page)', model: page({ live: 'offline', defaultDraft: { over: 6, under: 3, whenBeyond: 'BLOCK' }, save: { kind: 'unsaved', count: 1 } }) },
    { id: 'keys', label: 'The keys', model: page({ keysOpen: true }) },
  ],
})
