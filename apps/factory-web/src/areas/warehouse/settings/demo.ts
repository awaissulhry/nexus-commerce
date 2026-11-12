import type { ApprovalRule, AuditEntry, CrViRule, DefaultRow, Place, RulesAnswer, RulesView, SeparationView, SitePlaces } from './api'

/**
 * Made-up data for SCR-258's design cases (DEMO- codes, "Demo" names): never a real company, person, place or figure.
 */

export const NOW = '2026-11-12T09:42:00.000Z'
export const PREFIX = '/w/DEMO'
export const COMPANY_ID = '00000000-0000-4000-8000-000000000a01'
export const OTHER_COMPANY_ID = '00000000-0000-4000-8000-000000000a02'
export const TENANT_ID = '00000000-0000-4000-8000-000000000f01'
const id = (n: number) => `00000000-0000-4000-8355-${String(n).padStart(12, '0')}`

const words = (en: string, it: string) => ({ en, it })
const company = { id: COMPANY_ID, code: 'DEMO', name: 'Demo Factory Srl' }
const ANNA = { id: id(800), name: 'Anna Demo' }

// ---- posting dates, the adjustment value, low-stock alerts -----------------------------------------------------------------

/** This company: 7 days back of its own, € 500.00 of its own, low-stock alerts as every company (on). No approval rule on. */
export const RULES_COMPANY: RulesView = {
  companyId: COMPANY_ID,
  company,
  version: 3,
  updatedAt: '2026-11-10T08:15:00.000Z',
  changedBy: ANNA,
  mayChange: true,
  postingDates: { own: 7, inForce: { days: 7, source: 'COMPANY' }, today: '2026-11-12', earliest: '2026-11-05', limits: { min: 0, max: 366 } },
  adjustmentApproval: {
    own: 50000,
    inForce: { amount: 50000, source: 'COMPANY', set: true },
    currency: 'EUR',
    approvalRules: { active: 0, words: words('No approval rule for stock adjustments is on.', 'Nessuna regola di approvazione per le rettifiche è attiva.') },
    held: null,
  },
  lowStockAlerts: { own: null, inForce: { on: true, source: 'DEFAULT' } },
}

/** Every company: 3 days back, no adjustment value, low-stock alerts the default (on). */
export const RULES_TENANT: RulesView = {
  companyId: null,
  company: null,
  version: 1,
  updatedAt: '2026-11-02T16:05:00.000Z',
  changedBy: { id: id(801), name: 'Owner Demo' },
  mayChange: true,
  postingDates: { own: 3, inForce: { days: 3, source: 'TENANT' }, today: '2026-11-12', earliest: '2026-11-09', limits: { min: 0, max: 366 } },
  adjustmentApproval: { own: null, inForce: { amount: null, source: 'DEFAULT', set: false }, currency: null, approvalRules: { active: 0, words: words('—', '—') }, held: null },
  lowStockAlerts: { own: null, inForce: { on: true, source: 'DEFAULT' } },
}

/** A company that keeps nothing of its own: it follows every company. */
export const RULES_FOLLOWING: RulesView = {
  ...RULES_COMPANY,
  version: 0,
  updatedAt: null,
  changedBy: null,
  postingDates: { ...RULES_COMPANY.postingDates, own: null, inForce: { days: 3, source: 'TENANT' }, earliest: '2026-11-09' },
  adjustmentApproval: { ...RULES_COMPANY.adjustmentApproval, own: null, inForce: { amount: null, source: 'DEFAULT', set: false } },
}

/** One STOCK_ADJUSTMENT rule switched on. */
export const RULES_WAITS: RulesView = { ...RULES_COMPANY, adjustmentApproval: { ...RULES_COMPANY.adjustmentApproval, approvalRules: { active: 1, words: words('1 rule on.', '1 regola attiva.') } } }

/** A reader without the cost grain: the value is left out. */
export const withoutCost = (view: RulesView): RulesView => {
  const { own: _own, ...adjust } = view.adjustmentApproval
  const { amount: _amount, ...inForce } = adjust.inForce
  return { ...view, adjustmentApproval: { ...adjust, inForce, held: 'The value of an adjustment is a cost: it is shown only with the cost grain.' } }
}
export const readOnlyRules = (view: RulesView): RulesView => ({ ...view, mayChange: false })

// ---- separation of duties ------------------------------------------------------------------------------------------------

export const SEPARATION_COMPANY: SeparationView = {
  companyId: COMPANY_ID,
  version: 3,
  updatedAt: '2026-11-10T08:15:00.000Z',
  changedBy: ANNA,
  mayChange: true,
  switches: [
    { rule: 'COUNTER_NOT_APPROVER', own: null, inForce: { on: true, source: 'DEFAULT' } },
    { rule: 'RECEIVER_NOT_MATCHER', own: null, inForce: { on: true, source: 'DEFAULT' } },
  ],
  offReason: null,
}
export const SEPARATION_TENANT: SeparationView = { ...SEPARATION_COMPANY, companyId: null, version: 1, updatedAt: '2026-11-02T16:05:00.000Z', changedBy: { id: id(801), name: 'Owner Demo' } }
/** The receiver's rule switched off by this company, with its reason. */
export const SEPARATION_OFF: SeparationView = {
  ...SEPARATION_COMPANY,
  version: 4,
  switches: [
    { rule: 'COUNTER_NOT_APPROVER', own: null, inForce: { on: true, source: 'DEFAULT' } },
    { rule: 'RECEIVER_NOT_MATCHER', own: false, inForce: { on: false, source: 'COMPANY' } },
  ],
  offReason: 'Only one person works in the small plant until January (made-up).',
}
export const readOnlySeparation = (view: SeparationView): SeparationView => ({ ...view, mayChange: false })

// ---- the sites and their places --------------------------------------------------------------------------------------------

const place = (n: number, code: string, name: string, kind: Place['kind'], path: string[] = [code]): Place => ({ id: id(300 + n), code, name, kind, status: 'ACTIVE', path })

export const DOCK = place(1, 'DEMO-GI', 'Goods-in dock', 'RECEIVING')
export const QUARANTINE = place(2, 'DEMO-QA', 'Quality shelf', 'QUARANTINE')
export const RACK_A = place(3, 'DEMO-A', 'Rack A', 'ZONE')
export const BIN_A1 = place(4, 'DEMO-A1', 'Rack A, bin 1', 'BIN', ['DEMO-A', 'DEMO-A1'])
export const LEATHER_ROOM = place(5, 'DEMO-LR', 'Leather room', 'ZONE')
export const LINE_1 = place(6, 'DEMO-L1', 'Line 1 side rack', 'PRODUCTION')
export const FINISHED = place(7, 'DEMO-FG', 'Finished garments', 'FINISHED_GOODS')
export const PICK_1 = place(8, 'DEMO-PF1', 'Pick face 1', 'PICK_FACE')
export const SHIPPING = place(9, 'DEMO-SH', 'Packing bench', 'SHIPPING')

export const SITE_A: SitePlaces = { id: id(201), companyId: COMPANY_ID, code: 'DEMO-P1', name: 'Demo plant 1', locations: [DOCK, QUARANTINE, RACK_A, BIN_A1, LEATHER_ROOM, LINE_1, FINISHED, PICK_1, SHIPPING] }
export const SITE_B: SitePlaces = { id: id(202), companyId: COMPANY_ID, code: 'DEMO-P2', name: 'Demo plant 2', locations: [place(11, 'DEMO2-GI', 'Goods-in dock', 'RECEIVING'), place(12, 'DEMO2-ST', 'Store', 'WAREHOUSE')] }
export const SITE_OTHER: SitePlaces = { id: id(203), companyId: OTHER_COMPANY_ID, code: 'OTHER-P1', name: 'Other demo plant', locations: [place(21, 'OTH-GI', 'Goods-in dock', 'RECEIVING')] }
export const SITES: SitePlaces[] = [SITE_A, SITE_B, SITE_OTHER]

const row = (n: number, purpose: DefaultRow['purpose'], itemKind: DefaultRow['itemKind'], at: Place): DefaultRow => ({
  id: id(400 + n),
  itemKind,
  purpose,
  location: { id: at.id, code: at.code, name: at.name, kind: at.kind, status: at.status },
  version: 1,
  updatedAt: `2026-11-0${Math.min(9, n)}T10:00:00.000Z`,
  updatedById: ANNA.id,
})

export const DEFAULT_RECEIVING = row(1, 'RECEIVING', null, DOCK)
export const DEFAULT_QUALITY = row(2, 'QUALITY', null, QUARANTINE)
export const DEFAULT_PUT_AWAY = row(3, 'PUT_AWAY', null, BIN_A1)
export const DEFAULT_LEATHER_PUT = row(4, 'PUT_AWAY', 'LEATHER', LEATHER_ROOM)
export const DEFAULT_ISSUE = row(5, 'ISSUE', null, LINE_1)
export const DEFAULT_FINISHED_RECEIVING = row(6, 'RECEIVING', 'FINISHED', FINISHED)
export const DEFAULT_FINISHED_RETURN = row(7, 'RETURN', 'FINISHED', FINISHED)
export const DEFAULTS: DefaultRow[] = [DEFAULT_RECEIVING, DEFAULT_QUALITY, DEFAULT_PUT_AWAY, DEFAULT_LEATHER_PUT, DEFAULT_ISSUE, DEFAULT_FINISHED_RECEIVING, DEFAULT_FINISHED_RETURN]

// ---- who approves an adjustment (the engine's STOCK_ADJUSTMENT rules) --------------------------------------------------------

const rule = (n: number, over: Partial<ApprovalRule>): ApprovalRule => ({
  id: id(100 + n),
  kind: 'STOCK_ADJUSTMENT',
  kindLabel: words('Stock adjustment', 'Rettifica di giacenza'),
  registered: true,
  name: 'Demo rule',
  sentence: words('Stock adjustment: value over 500 → Warehouse manager', 'Rettifica di giacenza: valore oltre 500 → Responsabile magazzino'),
  companyId: COMPANY_ID,
  companyName: 'Demo Factory Srl',
  condition: { combinator: 'and', rows: [] },
  approver: { kind: 'ROLE', id: id(900), name: 'Warehouse manager' },
  signatureMeaning: null,
  requireStepUp: false,
  sequence: n,
  dueHours: 24,
  active: false,
  effectiveFrom: null,
  fired30Days: 0,
  changedBy: { id: ANNA.id, name: ANNA.name, me: false },
  updatedAt: '2026-11-10T08:15:00.000Z',
  canChange: true,
  heldReason: null,
  version: 1,
  ...over,
})

export const RULE_BIG = rule(1, { name: 'Adjustments over 500' })
export const RULE_FINANCE = rule(2, {
  name: 'Adjustments over 2,000 to Finance',
  sentence: words('Stock adjustment: value over 2000 → Finance', 'Rettifica di giacenza: valore oltre 2000 → Amministrazione'),
  approver: { kind: 'ROLE', id: id(901), name: 'Finance' },
  companyId: null,
  companyName: null,
})
const OTHER_KIND = rule(9, { kind: 'PURCHASE_ORDER', kindLabel: words('Purchase order', "Ordine d'acquisto"), name: 'Not a stock adjustment rule' })
const FIXED = [{ code: 'NO_SELF_APPROVAL' as const, sentence: words('Nobody approves their own request, the Owner included.', 'Nessuno approva la propria richiesta, nemmeno il titolare.') }]
export const rulesAnswer = (rules: readonly ApprovalRule[]): RulesAnswer => ({ asOf: NOW, rules: [...rules, OTHER_KIND], fixed: FIXED, canAdd: true })
export const APPROVALS_OFF = rulesAnswer([RULE_BIG, RULE_FINANCE])
export const APPROVALS_ON = rulesAnswer([{ ...RULE_BIG, active: true, fired30Days: 2, changedBy: { id: id(801), name: 'Owner Demo', me: false }, updatedAt: '2026-11-11T17:00:00.000Z', version: 2 }, RULE_FINANCE])
export const APPROVALS_NONE = rulesAnswer([])

// ---- the Cr VI evidence rule ---------------------------------------------------------------------------------------------------

export const CRVI_DEFAULT: CrViRule = { companyId: COMPANY_ID, crViEvidenceRule: 'SUPPLIER_REPORT_ACCEPTED', source: 'DEFAULT', default: 'SUPPLIER_REPORT_ACCEPTED', version: 0, updatedAt: null }
export const CRVI_LOT: CrViRule = { ...CRVI_DEFAULT, crViEvidenceRule: 'LOT_REPORT_REQUIRED', source: 'COMPANY', version: 2, updatedAt: '2026-10-30T09:00:00.000Z' }

// ---- "Changed by" ----------------------------------------------------------------------------------------------------------------

const entry = (n: number, at: string, card: string, actorName: string): AuditEntry => ({ id: id(500 + n), at, action: 'inventory.rules.save', recordId: COMPANY_ID, actorName, after: { card } })
export const RULES_AUDIT: AuditEntry[] = [
  entry(1, '2026-11-10T08:15:00.000Z', 'POSTING_DATES', 'Anna Demo'),
  entry(2, '2026-11-06T14:20:00.000Z', 'ADJUSTMENT_APPROVAL', 'Owner Demo'),
  entry(3, '2026-10-28T11:00:00.000Z', 'SEPARATION_OF_DUTIES', 'Owner Demo'),
]
export const DEFAULTS_AUDIT: AuditEntry[] = [{ id: id(510), at: '2026-11-09T10:00:00.000Z', action: 'inventory.locations.setDefault', recordId: DEFAULT_FINISHED_RETURN.id, actorName: 'Anna Demo' }]
