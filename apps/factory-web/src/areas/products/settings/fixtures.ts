import { createElement, useEffect, useState } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { NOW, PREFIX, ROLE_PERMISSIONS, uid, type RoleCase } from '../library/demo'
import type { ProductSettings } from './api'
import { AUDIT, CHANGED, COMPANY_FRESH, COMPANY_ID, COMPANY_SETTINGS, COSTING, COSTING_NO_GRAIN, LABELS, SCALES, TENANT_ID, TENANT_SETTINGS, TYPES, typeOf } from './demo'
import { changedByOf, failed, inheritedRules, mayKeepTypeOf, NO_ADDRESS, ready, rulesDraftOf, rulesLoosenings, toleranceDraftOf, typeDraftOf, type Address, type RulesDraft, type ToleranceDraft, type TypeDraft } from './model'
import type { ProductSettingsModel, SettingsCan, TypeDialogState } from './view-model'
import { ProductSettingsView } from './view/ProductSettingsView'
// B-W2b-283 (FU1:03, FU1:04): the measurement templates a type picks from; "Changed by" without audit.read.
import { DEMO_TEMPLATES, JACKET_TEMPLATE_A, OLD_JACKET_TEMPLATE } from './template-picker/fixtures'

/**
 * SCR-251 Products › Settings › Product settings — made-up data only (DEMO- codes, "Demo" names). Each case is a state the
 * Owner reviews: this company and every company, a company that never saved, the edit rules changed (tighter; looser: the
 * warning, the confirm with the reason), saving, saved, refused, a change elsewhere, the tolerance changed and held, the
 * product types (ticked, archived, none), the type dialog (new, a child with what it inherits, problems, refused, archived,
 * read only), the role cases (a product developer without the cost grain, a person over this company only, quality, sales),
 * loading, each read failed, offline and the keys. In the browser the scope, the cards and the dialogs work (the wrapper
 * keeps them); nothing is saved.
 */

interface DesignModel {
  readonly role: RoleCase | 'companyOnly'
  readonly model: ProductSettingsModel
}

const permissionsOf = (role: DesignModel['role']): readonly string[] => (role === 'companyOnly' ? ROLE_PERMISSIONS.developer : ROLE_PERMISSIONS[role])

const canOf = (role: DesignModel['role']): SettingsCan => {
  const held = new Set(permissionsOf(role))
  return { view: held.has('product.styles.view'), audit: held.has('audit.read'), costing: held.has('costing.view'), cost: held.has('money.cost'), finance: held.has('invoices.view'), labels: held.has('compliance.certificates.view') }
}

/** product.settings.manage over this company, and over every company (a person "over this company only" has the first). */
const rightsOf = (role: DesignModel['role']) => {
  const manage = permissionsOf(role).includes('product.settings.manage')
  return { company: manage, all: manage && role !== 'companyOnly' }
}

const address = (over: Partial<Address> = {}): Address => ({ ...NO_ADDRESS, ...over })

function page(over: Partial<ProductSettingsModel> = {}, role: DesignModel['role'] = 'owner', scope: Address['scope'] = 'company'): DesignModel {
  const rights = rightsOf(role)
  const can = canOf(role)
  const settings = scope === 'company' ? COMPANY_SETTINGS(rights.company) : TENANT_SETTINGS(rights.all)
  const tenant = TENANT_SETTINGS(rights.all)
  return {
    role,
    model: {
      prefix: PREFIX,
      address: address({ scope }),
      companyId: COMPANY_ID,
      rowId: scope === 'company' ? COMPANY_ID : TENANT_ID,
      companyName: 'Demo Factory Srl',
      can,
      settings: ready(settings),
      tenant: ready(tenant),
      rules: rulesDraftOf(settings),
      tolerance: toleranceDraftOf(settings, 'it'),
      types: ready(TYPES),
      selected: [],
      typeDialog: null,
      scales: ready(SCALES),
      labels: can.labels ? ready(LABELS) : null,
      templates: ready(DEMO_TEMPLATES), // B-W2b-283
      costing: can.costing ? ready(can.cost ? COSTING : COSTING_NO_GRAIN) : null,
      changed: can.audit ? { rules: changedByOf(AUDIT, 'editRule'), tolerance: changedByOf(AUDIT, 'consumptionTolerance'), types: CHANGED.types } : { rules: { at: CHANGED.rules.at, by: null }, tolerance: { at: CHANGED.rules.at, by: null }, types: { at: CHANGED.types.at, by: null } },
      busy: null,
      notice: null,
      loosen: null,
      live: 'live',
      asOf: NOW,
      changedElsewhere: false,
      keysOpen: false,
      ...over,
    },
  }
}

const allScope = (over: Partial<ProductSettingsModel> = {}, role: DesignModel['role'] = 'owner') => page({ ...over }, role, 'all')

const withSettings = (settings: ProductSettings, over: Partial<ProductSettingsModel> = {}, role: DesignModel['role'] = 'owner') =>
  page({ settings: ready(settings), rules: rulesDraftOf(settings), tolerance: toleranceDraftOf(settings, 'it'), changed: { rules: null, tolerance: null, types: CHANGED.types }, ...over }, role)

const COMPANY = COMPANY_SETTINGS()
const TENANT = TENANT_SETTINGS()
/** Tighter: development needs a new revision (no reason asked). */
const TIGHTER: RulesDraft = { ...rulesDraftOf(COMPANY), DEVELOPMENT: 'NEW_REVISION' }
/** Looser (every company): in production and phase-out edited with a new revision only. */
const LOOSER: RulesDraft = { ...rulesDraftOf(TENANT), IN_PRODUCTION: 'NEW_REVISION', PHASE_OUT: 'NEW_REVISION' }
const LOOSENINGS = rulesLoosenings(TENANT, LOOSER, inheritedRules('all', TENANT, TENANT), 'all')
const TOLERANCE_CHANGED: ToleranceDraft = (() => {
  const draft = toleranceDraftOf(COMPANY, 'it')
  return { ...draft, rule: 'WARN_ABOVE', percent: '4', byKind: { ...draft.byKind, LEATHER: { rule: 'WARN_ABOVE', percent: '6,5' }, PROTECTOR: { rule: 'NONE', percent: '' } } }
})()
const TOLERANCE_BAD: ToleranceDraft = { ...TOLERANCE_CHANGED, percent: '120', byKind: { ...TOLERANCE_CHANGED.byKind, LEATHER: { rule: 'WARN_ABOVE', percent: 'circa 5' } } }

const dialog = (draft: TypeDraft, over: Partial<TypeDialogState> = {}): TypeDialogState => ({ draft, shown: false, problem: null, changedBy: null, ...over })
const NEW_TYPE = typeDraftOf(null, COMPANY_ID)
const TOUR = typeOf('DEMO-JKT-TOUR')
const JKT = typeOf('DEMO-JKT')
const VEST = typeOf('DEMO-VEST')

function SettingsDesign({ model: design }: { model: DesignModel }) {
  const [current, setCurrent] = useState<ProductSettingsModel>(design.model)
  useEffect(() => setCurrent(design.model), [design])
  const set = (change: Partial<ProductSettingsModel>) => setCurrent((model) => ({ ...model, ...change }))
  const may = (companyId: string | null) => mayKeepTypeOf(current.address.scope, current.settings.value, current.tenant.value, current.live === 'offline', companyId)
  return createElement(ProductSettingsView, {
    model: current,
    actions: {
      onScope: (scope) => setCurrent(scope === 'all' ? allScope({}, design.role).model : page({}, design.role).model),
      onStatus: (status) => set({ address: { ...current.address, status }, selected: [] }),
      onRules: (rules) => set({ rules }),
      onDiscardRules: () => current.settings.value && set({ rules: rulesDraftOf(current.settings.value) }),
      onApplyRules: () => {
        const settings = current.settings.value
        if (!settings || !current.rules) return
        const loosenings = rulesLoosenings(settings, current.rules, inheritedRules(current.address.scope, settings, current.tenant.value), current.address.scope)
        set(loosenings.length > 0 ? { loosen: { reason: '', loosenings } } : { notice: { key: 'done.rules', tone: 'success' }, rules: rulesDraftOf(settings) })
      },
      onLoosenReason: (reason) => current.loosen && set({ loosen: { ...current.loosen, reason } }),
      onLoosenConfirm: () => current.settings.value && set({ loosen: null, notice: { key: 'done.rulesLoosened', tone: 'success' }, rules: rulesDraftOf(current.settings.value) }),
      onLoosenCancel: () => set({ loosen: null }),
      onTolerance: (tolerance) => set({ tolerance }),
      onDiscardTolerance: () => current.settings.value && set({ tolerance: toleranceDraftOf(current.settings.value, 'it') }),
      onApplyTolerance: () => current.settings.value && set({ notice: { key: 'done.tolerance', tone: 'success' }, tolerance: toleranceDraftOf(current.settings.value, 'it') }),
      onSelect: (ids) => set({ selected: [...ids] }),
      onTypeOpen: (id) => {
        const type = id === 'new' ? null : (TYPES.find((entry) => entry.id === id) ?? null)
        set({ typeDialog: dialog(typeDraftOf(type, may(COMPANY_ID) ? COMPANY_ID : null), { changedBy: type ? { at: type.updatedAt, by: current.can.audit ? 'Anna Demo' : null } : null }) })
      },
      onTypeDraft: (draft) => current.typeDialog && set({ typeDialog: { ...current.typeDialog, draft, problem: null } }),
      onTypeSave: () => current.typeDialog && set({ typeDialog: null, notice: { key: current.typeDialog.draft.id ? 'done.typeSaved' : 'done.typeAdded', tone: 'success', params: { code: current.typeDialog.draft.code || 'DEMO-NEW' } } }),
      onTypeClose: () => set({ typeDialog: null }),
      onTypeMove: (_type, to) => set({ notice: { key: to === 'archive' ? 'done.archived' : 'done.restored', tone: 'success', params: { count: 1 } } }),
      onBulkMove: (to) => set({ selected: [], notice: { key: to === 'archive' ? 'done.archived' : 'done.restored', tone: 'success', params: { count: current.selected.length } } }),
      onDismissNotice: () => set({ notice: null }),
      onKeys: () => set({ keysOpen: true }),
      onKeysClose: () => set({ keysOpen: false }),
    },
  })
}

export const designScreen = defineDesignScreen<DesignModel>({
  screen: 'SCR-251',
  title: 'Product settings',
  view: SettingsDesign,
  cases: [
    { id: 'company', label: 'Owner, this company: the product types, the edit rules (own and followed), the tolerance, the costing defaults', model: page(), note: 'The company edits samples freely and keeps its own thread and protector rules; everything else follows every company.' },
    { id: 'all', label: 'Every company: the rules a company follows where it keeps none of its own (the defaults below)', model: allScope() },
    { id: 'company-fresh', label: 'A company that never saved its own settings (everything followed)', model: withSettings(COMPANY_FRESH()) },
    { id: 'rules-tighter', label: 'Edit rules changed, tighter: development needs a new revision (Save, no reason)', model: page({ rules: TIGHTER }) },
    { id: 'rules-looser', label: 'Edit rules changed, looser (every company): said before Save', model: allScope({ rules: LOOSER }) },
    { id: 'loosen-confirm', label: 'Confirm a looser rule: each state from → to, the reason (empty: Save held)', model: allScope({ rules: LOOSER, loosen: { reason: '', loosenings: LOOSENINGS } }) },
    { id: 'loosen-reason', label: 'Confirm a looser rule with the reason typed', model: allScope({ rules: LOOSER, loosen: { reason: 'Small changes on running styles go with a revision; change orders stay for customers’ styles.', loosenings: LOOSENINGS } }) },
    { id: 'saving', label: 'Saving (the bar busy, every change held)', model: page({ rules: TIGHTER, busy: 'rules' }) },
    { id: 'saved', label: 'Saved: the looser rule with its reason in the audit trail', model: page({ notice: { key: 'done.rulesLoosened', tone: 'success' } }) },
    { id: 'stale', label: 'Refused: someone changed the settings meanwhile (read again)', model: page({ rules: TIGHTER, notice: { key: 'problem.write.moved', tone: 'danger' } }) },
    { id: 'changed-elsewhere', label: 'Live: changed on another screen while this one holds a change', model: page({ rules: TIGHTER, changedElsewhere: true }) },
    { id: 'tolerance-changed', label: 'Tolerance changed: warn above 4 %, leather 6,5 %, protectors back to the general rule', model: page({ tolerance: TOLERANCE_CHANGED }) },
    { id: 'tolerance-problem', label: 'Tolerance: a percent that is not one (Save held with why)', model: page({ tolerance: TOLERANCE_BAD }) },
    { id: 'types-selected', label: 'Product types: two ticked (Archive 2 · Restore held: none archived)', model: page({ selected: [typeOf('DEMO-JKT-URB').id, typeOf('DEMO-SUIT').id] }) },
    { id: 'types-archived', label: 'Product types: the archived ones', model: page({ address: address({ status: 'ARCHIVED' }) }) },
    { id: 'types-empty', label: 'Product types: none yet', model: page({ types: ready([]), changed: { ...CHANGED, types: null } }) },
    { id: 'type-new', label: 'New product type: code, name, garment, whose, parent, required fields, defaults', model: page({ typeDialog: dialog(NEW_TYPE), address: address({ type: 'new' }) }) },
    { id: 'type-child', label: 'A child type: the parent’s required fields ticked and fixed, each default it inherits said', model: page({ typeDialog: dialog(typeDraftOf(TOUR, TOUR.companyId), { changedBy: { at: TOUR.updatedAt, by: 'Anna Demo' } }), address: address({ type: TOUR.id }) }) },
    { id: 'type-top', label: 'A top type with 6 styles: its kind of garment stays (held with why)', model: page({ typeDialog: dialog(typeDraftOf(JKT, JKT.companyId), { changedBy: { at: JKT.updatedAt, by: 'Marco Demo' } }), address: address({ type: JKT.id }) }) },
    { id: 'type-problems', label: 'A new type with problems at its fields (a code with spaces, a standard without a PPE category)', model: page({ typeDialog: dialog({ ...NEW_TYPE, code: 'DEMO GLV 2', name: 'Winter gloves', productType: 'GLOVES', defaultPpeStandard: 'EN 13594:2015' }, { shown: true }) }) },
    { id: 'type-refused', label: 'A new type refused by the API: the code is taken', model: page({ typeDialog: dialog({ ...NEW_TYPE, code: 'DEMO-GLV', name: 'Gloves again', productType: 'GLOVES' }, { shown: true, problem: { key: 'problem.write.codeTaken', reload: false, fields: { code: 'type.problem.codeTaken' } } }) }) },
    { id: 'type-archived', label: 'An archived type: its facts as text, Restore', model: page({ address: address({ status: 'ALL', type: VEST.id }), typeDialog: dialog(typeDraftOf(VEST, VEST.companyId), { changedBy: { at: VEST.updatedAt, by: 'Anna Demo' } }) }) },
    { id: 'developer', label: 'Product developer (production manager): keeps every setting; the cost per minute is “Not in your role”; Finance settings not in the role', model: page({}, 'developer') },
    { id: 'company-only', label: 'A product developer over this company only: every company’s settings and types held with why', model: page({}, 'companyOnly') },
    { id: 'company-only-all', label: 'The same person on every company’s settings: view only', model: allScope({}, 'companyOnly') },
    { id: 'quality', label: 'Quality inspector: reads everything as text, changes nothing; no costing values, no names', model: page({}, 'quality') },
    { id: 'quality-type', label: 'Quality inspector opens a type: its facts as text', model: page({ typeDialog: dialog(typeDraftOf(TOUR, TOUR.companyId)) }, 'quality') },
    { id: 'sales', label: 'Sales: reads the settings, the costing defaults without the cost per minute, Finance settings opens', model: page({}, 'sales') },
    { id: 'no-permission', label: 'No permission (which permission, who grants it)', model: page({ can: { view: false, audit: false, costing: false, cost: false, finance: false, labels: false } }, 'sales') },
    { id: 'loading', label: 'Loading (each card its skeleton)', model: page({ settings: { value: null, problem: null }, tenant: { value: null, problem: null }, rules: null, tolerance: null, types: { value: null, problem: null }, costing: { value: null, problem: null }, asOf: null, live: 'connecting', changed: { rules: null, tolerance: null, types: null } }) },
    { id: 'error', label: 'The settings could not be read (the types and the costing still work)', model: page({ settings: { value: null, problem: 'problem.read.unavailable' }, tenant: { value: null, problem: 'problem.read.unavailable' }, rules: null, tolerance: null }) },
    { id: 'types-error', label: 'The product types could not be read (the cards still work)', model: page({ types: { value: null, problem: 'problem.read.internal' } }) },
    { id: 'costing-error', label: 'The costing defaults could not be read', model: page({ costing: { value: null, problem: 'problem.read.unavailable' } }) },
    { id: 'offline', label: 'Offline: the last copy, every change held (kept on this page)', model: page({ live: 'offline', rules: TIGHTER }) },
    { id: 'keys', label: 'The keys', model: page({ keysOpen: true }) },
    // B-W2b-283 (FU1:03): a type's measurement template is picked here (the active ones of its garment and company).
    { id: 'w2b-283-template-pick', label: 'W2b-283 A type picks its measurement template', model: page({ typeDialog: dialog(typeDraftOf(TOUR, TOUR.companyId)), address: address({ type: TOUR.id }) }), note: 'Jacket templates of this company and every company, with their points and whether their made-to-measure rules are on; archived and other garments’ templates are not offered.' },
    { id: 'w2b-283-template-picked', label: 'W2b-283 A template picked (Save offered)', model: page({ typeDialog: dialog({ ...typeDraftOf(TOUR, TOUR.companyId), measurementTemplateId: JACKET_TEMPLATE_A.id }), address: address({ type: TOUR.id }) }) },
    { id: 'w2b-283-template-kept', label: 'W2b-283 A type naming an archived template', model: page({ typeDialog: dialog({ ...typeDraftOf(TOUR, TOUR.companyId), measurementTemplateId: OLD_JACKET_TEMPLATE.id }), address: address({ type: TOUR.id }) }), note: 'Kept as an option "no longer offered" until another is picked or it is cleared.' },
    { id: 'w2b-283-template-none', label: 'W2b-283 No template for this garment yet', model: page({ typeDialog: dialog({ ...NEW_TYPE, code: 'DEMO-GLV-2', name: 'Winter gloves', productType: 'GLOVES' }) }), note: 'Said in words; the made-to-measure office adds templates (B-W2b-358).' },
    { id: 'w2b-283-template-reading', label: 'W2b-283 The templates are read', model: page({ templates: { value: null, problem: null }, typeDialog: dialog(typeDraftOf(TOUR, TOUR.companyId)), address: address({ type: TOUR.id }) }) },
    { id: 'w2b-283-template-failed', label: 'W2b-283 The templates could not be read', model: page({ templates: failed('problem.read.unavailable'), typeDialog: dialog(typeDraftOf(TOUR, TOUR.companyId)), address: address({ type: TOUR.id }) }), note: 'The value stays as text with why; nothing else is held.' },
    // B-W2b-283 (FU1:04): "Changed by" from the rows themselves, for a role without audit.read.
    {
      id: 'w2b-283-changed-by',
      label: 'W2b-283 Changed by, without audit.read (the row’s own last changer)',
      model: page(
        {
          settings: ready({ ...COMPANY, changedBy: { id: uid('9283', 1), name: 'Anna Demo' } }),
          types: ready(TYPES.map((type) => (type.id === TOUR.id ? { ...type, changedBy: { id: uid('9283', 2), name: 'Marco Demo' } } : type))),
          changed: { rules: { at: CHANGED.rules.at, by: 'Anna Demo' }, tolerance: { at: CHANGED.rules.at, by: 'Anna Demo' }, types: { at: CHANGED.types.at, by: 'Marco Demo' } },
          typeDialog: dialog(typeDraftOf(TOUR, TOUR.companyId)),
          address: address({ type: TOUR.id }),
        },
        'quality',
      ),
      note: 'The quality inspector reads no audit trail: each card and the type say who saved them last (no link to the audit log).',
    },
  ],
})
