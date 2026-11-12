import { createElement, useEffect, useState } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { STEP_UP_CLOSED } from '../../quality/_shared/hooks'
import type { RulesView, SeparationView } from './api'
import {
  APPROVALS_NONE,
  APPROVALS_OFF,
  APPROVALS_ON,
  BIN_A1,
  COMPANY_ID,
  CRVI_DEFAULT,
  CRVI_LOT,
  DEFAULTS,
  DEFAULTS_AUDIT,
  NOW,
  PREFIX,
  QUARANTINE,
  readOnlyRules,
  readOnlySeparation,
  RULES_AUDIT,
  RULES_COMPANY,
  RULES_FOLLOWING,
  RULES_TENANT,
  RULES_WAITS,
  SEPARATION_COMPANY,
  SEPARATION_OFF,
  SEPARATION_TENANT,
  SITES,
  TENANT_ID,
  withoutCost,
} from './demo'
import {
  amountDraftOf,
  cardChangedOf,
  cellKey,
  daysDraftOf,
  defaultsChangedOf,
  dirtyCards,
  failed,
  NO_ADDRESS,
  reading,
  ready,
  separationDraftOf,
  type Address,
} from './model'
import type { SettingsCan, WarehouseSettingsModel } from './view-model'
import { WarehouseSettingsView } from './view/WarehouseSettingsView'

/**
 * SCR-258 Warehouse › Settings › Warehouse rules — made-up data only (DEMO- codes, "Demo" names). Each case is a state the
 * Owner reviews: this company and every company, a company that follows every company; separation of duties on (the
 * default), one switched off with its reason, a switch being turned off (the reason, then "Confirm it is you", a wrong code);
 * posting dates kept, loosened (the reason) and held (out of range); default locations per site (cells typed, a kind added,
 * none yet, no site); the adjustment value with no approval rule on (the honest default), one on, none written, raised (the
 * reason), without the cost grain; low-stock alerts off; the Cr VI rule (the default, a report per lot, not readable); the
 * role cases (the Owner, warehouse, finance, a reader); saving, saved, refused, changed elsewhere, loading, each read failed,
 * offline, the keys, no permission. In the browser the scope, the cards and the dialog work (the wrapper keeps them); nothing
 * is saved.
 */

type Role = 'owner' | 'warehouse' | 'finance' | 'reader' | 'none'

const CAN: Record<Role, SettingsCan> = {
  owner: { view: true, rules: true, locations: true, locationsManage: true, cost: true, approvals: true, approvalsManage: true, crVi: true, audit: true },
  warehouse: { view: true, rules: true, locations: true, locationsManage: true, cost: false, approvals: true, approvalsManage: false, crVi: true, audit: false },
  finance: { view: true, rules: true, locations: true, locationsManage: false, cost: true, approvals: true, approvalsManage: false, crVi: false, audit: true },
  reader: { view: true, rules: false, locations: true, locationsManage: false, cost: false, approvals: true, approvalsManage: false, crVi: true, audit: true },
  none: { view: false, rules: false, locations: false, locationsManage: false, cost: false, approvals: false, approvalsManage: false, crVi: false, audit: false },
}

const address = (over: Partial<Address> = {}): Address => ({ ...NO_ADDRESS, ...over })

function rulesFor(role: Role, view: RulesView): RulesView {
  const scoped = role === 'reader' || role === 'none' ? readOnlyRules(view) : view
  return CAN[role].cost ? scoped : withoutCost(scoped)
}

/** A page of the design: the drafts from the reads, "Changed by" from the reads and the audit trail the role reaches. */
function page(over: Partial<WarehouseSettingsModel> = {}, role: Role = 'owner'): WarehouseSettingsModel {
  const can = CAN[role]
  const scope = over.address?.scope ?? 'company'
  const rulesView = over.rules?.value ?? rulesFor(role, scope === 'all' ? RULES_TENANT : RULES_COMPANY)
  const separationView = over.separation?.value ?? (role === 'reader' ? readOnlySeparation(SEPARATION_COMPANY) : scope === 'all' ? SEPARATION_TENANT : SEPARATION_COMPANY)
  const audit = can.audit ? RULES_AUDIT : null
  const defaults = over.defaults === undefined ? (can.locations ? DEFAULTS : null) : (over.defaults?.value ?? null)
  const base: WarehouseSettingsModel = {
    prefix: PREFIX,
    address: address(),
    companyId: COMPANY_ID,
    companyName: 'Demo Factory Srl',
    can,
    rules: ready(rulesView),
    tenantRules: scope === 'company' ? rulesFor(role, RULES_TENANT) : null,
    separation: ready(separationView),
    tenantSeparation: scope === 'company' ? SEPARATION_TENANT : null,
    separationDraft: separationDraftOf(separationView),
    daysDraft: daysDraftOf(rulesView, scope),
    amountDraft: amountDraftOf(rulesView, scope),
    alertsDraft: rulesView.lowStockAlerts.own,
    reasons: { separation: '', posting: '', adjust: '' },
    reasonAsked: [],
    sites: can.locations ? ready(SITES) : null,
    defaults: can.locations ? ready(DEFAULTS) : null,
    defaultsDraft: {},
    addedKinds: [],
    approvalRules: can.approvals ? ready(APPROVALS_OFF) : null,
    crVi: can.crVi ? ready(CRVI_DEFAULT) : null,
    changed: {
      separation: cardChangedOf('SEPARATION_OF_DUTIES', separationView, audit),
      posting: cardChangedOf('POSTING_DATES', rulesView, audit),
      adjust: cardChangedOf('ADJUSTMENT_APPROVAL', rulesView, audit),
      alerts: cardChangedOf('LOW_STOCK_ALERTS', rulesView, audit),
      defaults: defaults ? defaultsChangedOf(defaults, can.audit ? DEFAULTS_AUDIT : null) : null,
    },
    rowId: scope === 'all' ? TENANT_ID : COMPANY_ID,
    busy: null,
    save: { kind: 'idle' },
    notice: null,
    live: 'live',
    asOf: NOW,
    changedElsewhere: false,
    keysOpen: false,
    stepUp: STEP_UP_CLOSED,
  }
  const model = { ...base, ...over }
  // SaveStatus counts the cards a case holds changed in (unless the case says otherwise).
  if (!over.save) {
    const dirty = dirtyCards(model)
    if (dirty.length > 0) return { ...model, save: { kind: 'unsaved', count: dirty.length } }
  }
  return model
}

const withSeparation = (view: SeparationView, over: Partial<WarehouseSettingsModel> = {}, role: Role = 'owner') => page({ separation: ready(view), separationDraft: separationDraftOf(view), ...over }, role)
const withRules = (view: RulesView, over: Partial<WarehouseSettingsModel> = {}, role: Role = 'owner') =>
  page({ rules: ready(view), daysDraft: daysDraftOf(view, over.address?.scope ?? 'company'), amountDraft: amountDraftOf(view, over.address?.scope ?? 'company'), alertsDraft: view.lowStockAlerts.own, ...over }, role)

const OFF_TYPED = { ...separationDraftOf(SEPARATION_COMPANY), COUNTER_NOT_APPROVER: false }
const STEP_UP_OPEN = { open: true, busy: false, sentence: 'stepUp.sentence.separation', problem: null }
const ALL = address({ scope: 'all' })

function SettingsDesign({ model: design }: { model: WarehouseSettingsModel }) {
  const [current, setCurrent] = useState<WarehouseSettingsModel>(design)
  useEffect(() => setCurrent(design), [design])
  const set = (change: Partial<WarehouseSettingsModel>) =>
    setCurrent((model) => {
      const next = { ...model, ...change }
      const dirty = dirtyCards(next)
      return change.save ? next : { ...next, save: dirty.length > 0 ? { kind: 'unsaved', count: dirty.length } : { kind: 'idle' } }
    })
  return createElement(WarehouseSettingsView, {
    model: current,
    actions: {
      onScope: (scope) => setCurrent(scope === 'all' ? page({ address: ALL, can: current.can }) : { ...design, address: address(), can: current.can }),
      onSite: (siteId) => set({ address: { ...current.address, site: siteId }, defaultsDraft: {}, addedKinds: [], defaults: ready(siteId === SITES[0]!.id ? DEFAULTS : []) }),
      onSeparation: (separationDraft) => set({ separationDraft }),
      onDays: (daysDraft) => set({ daysDraft }),
      onAmount: (amountDraft) => set({ amountDraft }),
      onAlerts: (alertsDraft) => set({ alertsDraft }),
      onReason: (card, reason) => set({ reasons: { ...current.reasons, [card]: reason } }),
      onDiscard: (card) => {
        const rules = current.rules.value!
        const scope = current.address.scope
        if (card === 'separation') set({ separationDraft: separationDraftOf(current.separation.value!), reasons: { ...current.reasons, separation: '' } })
        if (card === 'posting') set({ daysDraft: daysDraftOf(rules, scope), reasons: { ...current.reasons, posting: '' } })
        if (card === 'adjust') set({ amountDraft: amountDraftOf(rules, scope), reasons: { ...current.reasons, adjust: '' } })
        if (card === 'alerts') set({ alertsDraft: rules.lowStockAlerts.own })
        if (card === 'defaults') set({ defaultsDraft: {}, addedKinds: [] })
      },
      onApply: (card) => {
        if (card === 'separation' && current.separationDraft && Object.values(current.separationDraft).includes(false)) return set({ stepUp: STEP_UP_OPEN, busy: 'separation' })
        const done = card === 'defaults' ? { key: 'done.defaults', tone: 'success' as const, params: { count: Object.keys(current.defaultsDraft).length } } : { key: `done.${card}`, tone: 'success' as const }
        set({ notice: done, save: { kind: 'saved', at: NOW }, ...(card === 'defaults' ? { defaultsDraft: {} } : {}) })
      },
      onCell: (key, locationId) => set({ defaultsDraft: { ...current.defaultsDraft, [key]: locationId } }),
      onAddKind: (kind) => set({ addedKinds: [...current.addedKinds, kind] }),
      onOpenRule: () => set({ notice: { key: 'adjust.inboxLink', tone: 'info' } }),
      onStepUpSubmit: () => set({ stepUp: STEP_UP_CLOSED, busy: null, notice: { key: 'done.separationOff', tone: 'success' }, separation: ready(SEPARATION_OFF), separationDraft: separationDraftOf(SEPARATION_OFF), save: { kind: 'saved', at: NOW } }),
      onStepUpCancel: () => set({ stepUp: STEP_UP_CLOSED, busy: null, notice: { key: 'stepUp.cancelled', tone: 'warning' } }),
      onDismissNotice: () => set({ notice: null }),
      onKeys: () => set({ keysOpen: true }),
      onKeysClose: () => set({ keysOpen: false }),
    },
  })
}

const LOADING: Partial<WarehouseSettingsModel> = {
  rules: reading(),
  tenantRules: null,
  separation: reading(),
  tenantSeparation: null,
  separationDraft: null,
  daysDraft: null,
  amountDraft: null,
  alertsDraft: undefined,
  sites: reading(),
  defaults: reading(),
  approvalRules: reading(),
  crVi: reading(),
  asOf: null,
  live: 'connecting',
  changed: { separation: null, posting: null, adjust: null, alerts: null, defaults: null },
}

export const designScreen = defineDesignScreen<WarehouseSettingsModel>({
  screen: 'SCR-258',
  title: 'Warehouse rules',
  view: SettingsDesign,
  cases: [
    { id: 'owner', label: 'Owner, this company: both separation rules on, 7 days back, default places of plant 1, € 500.00 with no approval rule on, the Cr VI rule (the default)', model: page(), note: 'Nobody approves their own request, the Owner included; no approval rule is on until the Owner switches one on in Admin › Approvals, automation & AI.' },
    { id: 'all', label: 'Every company: the rules every company follows (3 days back, no value), every site', model: page({ address: ALL }) },
    { id: 'following', label: 'A company that keeps nothing of its own: it follows every company (3 days back, no adjustment value)', model: withRules(RULES_FOLLOWING, { changed: { separation: null, posting: null, adjust: null, alerts: null, defaults: defaultsChangedOf(DEFAULTS, DEFAULTS_AUDIT) } }) },
    { id: 'sod-off', label: 'Separation: the receiver’s rule switched off by this company, with its reason', model: withSeparation(SEPARATION_OFF) },
    { id: 'sod-turning-off', label: 'Separation: the counter’s rule being switched off — the reason first, Save asks for a code', model: page({ separationDraft: OFF_TYPED, reasons: { separation: 'Only one counter on the night shift this month (made-up).', posting: '', adjust: '' } }) },
    { id: 'sod-no-reason', label: 'Separation: switched off without a reason (Save held with why)', model: page({ separationDraft: OFF_TYPED, reasonAsked: ['separation'] }) },
    { id: 'step-up', label: 'Confirm it is you: a fresh 6-digit code before a separation rule is switched off', model: page({ separationDraft: OFF_TYPED, reasons: { separation: 'Only one counter on the night shift this month (made-up).', posting: '', adjust: '' }, busy: 'separation', stepUp: STEP_UP_OPEN }) },
    { id: 'step-up-wrong', label: 'Confirm it is you: a wrong code (said in the dialog)', model: page({ separationDraft: OFF_TYPED, reasons: { separation: 'Only one counter on the night shift this month (made-up).', posting: '', adjust: '' }, busy: 'separation', stepUp: { ...STEP_UP_OPEN, problem: 'stepUp.problem.wrong' } }) },
    { id: 'posting-loosened', label: 'Posting dates: 14 days back typed (more than 7): the reason, then a code', model: page({ daysDraft: { mode: 'OWN', days: 14 } }) },
    { id: 'posting-tighter', label: 'Posting dates: 2 days back typed (tighter: no reason, no code)', model: page({ daysDraft: { mode: 'OWN', days: 2 } }) },
    { id: 'posting-problem', label: 'Posting dates held: 400 is more than 366 days', model: page({ daysDraft: { mode: 'OWN', days: 400 } }) },
    { id: 'posting-follow', label: 'Posting dates: back to every company’s 3 days (tighter)', model: page({ daysDraft: { mode: 'FOLLOW', days: '' } }) },
    { id: 'defaults-typed', label: 'Default places: leather put away in Rack A, bin 1 and quality cleared (typed, EditModeBar)', model: page({ defaultsDraft: { [cellKey('PUT_AWAY', 'LEATHER')]: BIN_A1.id, [cellKey('QUALITY', null)]: null } }) },
    { id: 'defaults-added', label: 'Default places: a kind of material added as a row (lining), its cells following the first row', model: page({ addedKinds: ['LINING'], defaultsDraft: { [cellKey('QUALITY', 'LINING')]: QUARANTINE.id } }) },
    { id: 'defaults-none', label: 'Default places: none kept on plant 2 yet (every command uses its own rule)', model: page({ address: address({ site: SITES[1]!.id }), defaults: ready([]), changed: { separation: null, posting: null, adjust: null, alerts: null, defaults: null } }) },
    { id: 'adjust-waits', label: 'Adjustment approval: one rule switched on — adjustments above € 500.00 wait for a yes', model: withRules(RULES_WAITS, { approvalRules: ready(APPROVALS_ON) }) },
    { id: 'adjust-none-written', label: 'Adjustment approval: no approval rule written yet', model: page({ approvalRules: ready(APPROVALS_NONE) }) },
    { id: 'adjust-raised', label: 'Adjustment approval: the value raised to € 1,500.00 (fewer wait): the reason, then a code', model: page({ amountDraft: { mode: 'OWN', amount: 1500 }, reasons: { separation: '', posting: '', adjust: 'Leather hides are counted by area: small differences are worth more (made-up).' } }) },
    { id: 'adjust-no-value', label: 'Adjustment approval: no value anywhere (every adjustment posts at once)', model: withRules({ ...RULES_COMPANY, adjustmentApproval: { ...RULES_COMPANY.adjustmentApproval, own: null, inForce: { amount: null, source: 'DEFAULT', set: false } } }) },
    { id: 'alerts-off', label: 'Low-stock alerts switched off (typed: no code)', model: page({ alertsDraft: false }) },
    { id: 'crvi-lot', label: 'Cr VI rule: a report per lot, this company’s own', model: page({ crVi: ready(CRVI_LOT) }) },
    { id: 'saving', label: 'Saving the posting dates (the bar busy, every change held)', model: page({ daysDraft: { mode: 'OWN', days: 2 }, busy: 'posting', save: { kind: 'saving' } }) },
    { id: 'saved', label: 'Saved', model: page({ notice: { key: 'done.posting', tone: 'success' }, save: { kind: 'saved', at: NOW } }) },
    { id: 'stale', label: 'Refused: someone changed the rules meanwhile (read again, nothing overwritten)', model: page({ daysDraft: { mode: 'OWN', days: 2 }, notice: { key: 'problem.write.moved', tone: 'danger' }, save: { kind: 'failed', count: 1 } }) },
    { id: 'changed-elsewhere', label: 'Live: changed on another screen while this one holds a change', model: page({ daysDraft: { mode: 'OWN', days: 2 }, changedElsewhere: true }) },
    { id: 'warehouse', label: 'Warehouse: keeps the rules and the places; the value is a cost (held), approval rules read-only', model: page({}, 'warehouse') },
    { id: 'finance', label: 'Finance: keeps the rules and the value; default places as text; the Cr VI rule not in the role', model: page({}, 'finance') },
    { id: 'reader', label: 'A reader (inventory.stock.view): everything as text, every change held with why', model: page({}, 'reader') },
    { id: 'no-permission', label: 'No permission (which permission, who grants it)', model: page({}, 'none') },
    { id: 'loading', label: 'Loading (each card its skeleton)', model: page(LOADING) },
    { id: 'error', label: 'Every read failed: each card its words and Try again (never drawn as empty)', model: page({ ...LOADING, live: 'live', asOf: NOW, rules: failed('problem.read.unavailable'), separation: failed('problem.read.internal'), sites: failed('problem.read.unavailable'), defaults: null, approvalRules: failed('problem.read.unavailable'), crVi: failed('problem.read.forbidden') }) },
    { id: 'no-site', label: 'Default places: no site yet', model: page({ sites: ready([]), defaults: null }) },
    { id: 'offline', label: 'Offline: the last copy, every change held (kept on this page)', model: page({ live: 'offline', daysDraft: { mode: 'OWN', days: 2 }, defaultsDraft: { [cellKey('ISSUE', null)]: BIN_A1.id } }) },
    { id: 'keys', label: 'The keys', model: page({ keysOpen: true }) },
  ],
})
