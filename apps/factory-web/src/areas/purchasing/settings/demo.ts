import type { AlertRule, ApprovalRule, AuditEntry, KindsAnswer, MaterialRef, ReminderSettings, RulesAnswer, SupplierRef, Tolerance } from './api'

/**
 * Made-up data for SCR-256's design cases (DEMO- codes, "Demo" names, example.com): never a real supplier, person or figure.
 */

export const NOW = '2026-11-12T09:42:00.000Z'
export const PREFIX = '/w/DEMO'
export const COMPANY_ID = '00000000-0000-4000-8000-000000000a01'
export const TENANT_ID = '00000000-0000-4000-8000-000000000f01'
const id = (n: number) => `00000000-0000-4000-8354-${String(n).padStart(12, '0')}`

const words = (en: string, it: string) => ({ en, it })

// ---- PO approval ------------------------------------------------------------------------------------------------------------

const rule = (n: number, over: Partial<ApprovalRule>): ApprovalRule => ({
  id: id(100 + n),
  kind: 'PURCHASE_ORDER',
  kindLabel: words('Purchase order', "Ordine d'acquisto"),
  registered: true,
  name: 'Demo rule',
  sentence: words('Purchase order: order value over 5000 → Finance', "Ordine d'acquisto: valore dell'ordine oltre 5000 → Finanza"),
  companyId: COMPANY_ID,
  companyName: 'Demo Factory Srl',
  condition: { combinator: 'and', rows: [] },
  approver: { kind: 'ROLE', id: id(900), name: 'Finance' },
  signatureMeaning: null,
  requireStepUp: false,
  sequence: n,
  dueHours: 24,
  active: false,
  effectiveFrom: null,
  fired30Days: 0,
  changedBy: { id: id(800), name: 'Anna Demo', me: false },
  updatedAt: '2026-11-10T08:15:00.000Z',
  canChange: true,
  heldReason: null,
  version: 1,
  ...over,
})

export const RULE_BIG = rule(1, {
  name: 'Orders over 5,000',
  sentence: words('Purchase order: order value over 5000 → Finance, signed ‘Approved’', "Ordine d'acquisto: valore dell'ordine oltre 5000 → Finanza, firmato ‘Approvato’"),
  signatureMeaning: 'APPROVED',
  requireStepUp: true,
})
export const RULE_GROWS = rule(2, {
  name: 'A sent order that grows by more than 1,000',
  sentence: words('Purchase order: revision over 1 and value added since the last send over 1000 → Finance', "Ordine d'acquisto: revisione oltre 1 e valore aggiunto dall'ultimo invio oltre 1000 → Finanza"),
  dueHours: 8,
})
export const RULE_PROSPECT = rule(3, {
  name: 'Orders to a prospect supplier',
  sentence: words('Purchase order: supplier status is Prospect → Marco Demo', "Ordine d'acquisto: stato del fornitore è Potenziale → Marco Demo"),
  approver: { kind: 'PERSON', id: id(801), name: 'Marco Demo' },
  companyId: null,
  companyName: null,
  dueHours: null,
  changedBy: { id: id(802), name: 'Lucia Prova', me: false },
  updatedAt: '2026-11-11T16:05:00.000Z',
})
const OTHER_KIND = rule(9, { kind: 'SALES_ORDER', kindLabel: words('Sales order', 'Ordine di vendita'), name: 'Not a purchase order rule' })

const FIXED = [{ code: 'NO_SELF_APPROVAL' as const, sentence: words('Nobody approves their own request, the Owner included.', 'Nessuno approva la propria richiesta, nemmeno il titolare.') }]
export const rulesAnswer = (rules: readonly ApprovalRule[], canAdd = true): RulesAnswer => ({ asOf: NOW, rules: [...rules, OTHER_KIND], fixed: FIXED, canAdd })

export const RULES_OFF = rulesAnswer([RULE_BIG, RULE_GROWS, RULE_PROSPECT])
export const RULES_ON = rulesAnswer([{ ...RULE_BIG, active: true, fired30Days: 4, changedBy: { id: id(803), name: 'Owner Demo', me: true }, updatedAt: '2026-11-12T07:30:00.000Z', version: 2 }, RULE_GROWS, RULE_PROSPECT])
export const RULES_NONE = rulesAnswer([])

export const KINDS: KindsAnswer = {
  kinds: [
    {
      kind: 'PURCHASE_ORDER',
      recordType: 'PurchaseOrder',
      label: words('Purchase order', "Ordine d'acquisto"),
      askable: true,
      fields: [
        ['orderValue', 'order value', "valore dell'ordine"],
        ['currency', 'currency', 'valuta'],
        ['lineCount', 'lines', 'righe'],
        ['supplierStatus', 'supplier status', 'stato del fornitore'],
        ['supplierCode', 'supplier code', 'codice fornitore'],
        ['siteCode', 'site code', 'codice sede'],
        ['revision', 'revision', 'revisione'],
        ['valueIncrease', 'value added since the last send', "valore aggiunto dall'ultimo invio"],
      ].map(([field, en, it]) => ({ id: field!, label: words(en!, it!), kind: 'number' as const, unit: null, grain: null, options: [], min: null, max: null, heldReason: null })),
    },
  ],
  notRegistered: [],
  meanings: [],
  operators: [],
}

// ---- delivery tolerances ----------------------------------------------------------------------------------------------------

const company = { code: 'DEMO', name: 'Demo Factory Srl' }
const tol = (n: number, over: Partial<Tolerance>): Tolerance => ({
  id: id(200 + n),
  companyId: COMPANY_ID,
  company,
  supplierId: null,
  supplier: null,
  itemId: null,
  item: null,
  itemKind: null,
  overPct: '5',
  underPct: '5',
  whenBeyond: 'BLOCK',
  status: 'ACTIVE',
  note: null,
  version: 1,
  createdAt: `2026-10-0${Math.min(9, n)}T09:00:00.000Z`,
  updatedAt: `2026-11-0${Math.min(9, n)}T10:00:00.000Z`,
  updatedById: id(800),
  mayChange: true,
  ...over,
})

export const TANNERY = { id: id(301), code: 'DEMO-TAN', name: 'Conceria Demo Spa' }
export const ZIPS = { id: id(302), code: 'DEMO-ZIP', name: 'Zip Demo Srl' }
export const WORKSHOP = { id: id(303), code: 'DEMO-WS', name: 'Laboratorio Demo' }

export const ALL_DEFAULT = tol(1, { companyId: null, company: null, overPct: '2', underPct: '2' })
export const OWN_DEFAULT = tol(2, { overPct: '5', underPct: '3' })
export const LEATHER_TANNERY = tol(3, { supplierId: TANNERY.id, supplier: { code: TANNERY.code, name: TANNERY.name }, itemKind: 'LEATHER', overPct: '8', underPct: '5', note: 'Agreed with the tannery for hides sold by area (made-up).' })
export const ZIPS_EXACT = tol(4, { supplierId: ZIPS.id, supplier: { code: ZIPS.code, name: ZIPS.name }, overPct: '0', underPct: '0' })
export const PROTECTORS = tol(5, { companyId: null, company: null, itemKind: 'PROTECTOR', overPct: '0', underPct: '0', note: 'Certified protectors: exactly as ordered.' })
export const MESH_ONE = tol(6, { itemId: id(401), item: { code: 'DEMO-MESH-01', name: 'Demo mesh 3D' }, overPct: '10', underPct: '5', whenBeyond: 'APPROVAL' })
export const OLD_WORKSHOP = tol(7, { supplierId: WORKSHOP.id, supplier: { code: WORKSHOP.code, name: WORKSHOP.name }, overPct: '3', underPct: '3', status: 'ARCHIVED' })

export const TOLERANCES: Tolerance[] = [ALL_DEFAULT, OWN_DEFAULT, LEATHER_TANNERY, ZIPS_EXACT, PROTECTORS, MESH_ONE, OLD_WORKSHOP]
export const TOLERANCES_FOLLOWING: Tolerance[] = [ALL_DEFAULT, LEATHER_TANNERY, PROTECTORS]
export const readOnly = (rows: readonly Tolerance[]): Tolerance[] => rows.map((row) => ({ ...row, mayChange: false }))

export const SUPPLIERS: SupplierRef[] = [TANNERY, WORKSHOP, ZIPS].map(({ id: supplierId, code, name }) => ({ id: supplierId, code, name }))
export const MATERIALS: MaterialRef[] = [
  { id: id(401), code: 'DEMO-MESH-01', name: 'Demo mesh 3D', kind: 'TEXTILE' },
  { id: id(402), code: 'DEMO-LTH-01', name: 'Demo cowhide 1.2 mm', kind: 'LEATHER' },
  { id: id(403), code: 'DEMO-ZIP-05', name: 'Demo zip no. 5', kind: 'TRIM' },
]

export const TOLERANCE_AUDIT: AuditEntry[] = [{ id: id(501), at: '2026-11-11T14:20:00.000Z', action: 'purchasing.tolerances.update', recordId: LEATHER_TANNERY.id, actorName: 'Anna Demo' }]

// ---- confirmation -------------------------------------------------------------------------------------------------------------

const settingsRow = (on: boolean, companyId: string | null, version = 1) => ({ id: companyId ?? TENANT_ID, companyId, confirmationRemindersEnabled: on, version, updatedAt: '2026-11-09T11:00:00.000Z' })
export const REMINDERS_DEFAULT: ReminderSettings = { companyId: COMPANY_ID, source: 'DEFAULT', on: false, mayChange: true, company: null, tenant: null }
export const REMINDERS_OWN_ON: ReminderSettings = { companyId: COMPANY_ID, source: 'COMPANY', on: true, mayChange: true, company: settingsRow(true, COMPANY_ID, 2), tenant: null }
export const REMINDERS_FOLLOW: ReminderSettings = { companyId: COMPANY_ID, source: 'TENANT', on: false, mayChange: true, company: null, tenant: settingsRow(false, null) }
export const REMINDERS_ALL: ReminderSettings = { companyId: null, source: 'TENANT', on: false, mayChange: true, company: null, tenant: settingsRow(false, null) }
export const SWITCH_AUDIT: AuditEntry[] = [{ id: id(502), at: '2026-11-09T11:00:00.000Z', action: 'purchasing.remindersSwitch', recordId: COMPANY_ID, actorName: 'Owner Demo' }]

export const ALERT_BUILT_IN: AlertRule = {
  id: id(601),
  ruleKind: 'PO_NOT_CONFIRMED',
  name: 'Purchase order not confirmed',
  sentence: words('Purchase order not confirmed by its confirm-by time (2 days after the send without one) → Buyer', "Ordine di acquisto non confermato entro la sua scadenza (2 giorni dall'invio se manca) → Acquisti"),
  place: { companyId: null, siteId: null, label: null },
  recipient: { roleId: id(901), name: 'Buyer' },
  enabled: true,
  builtIn: true,
  fired7Days: 2,
  openAlerts: 1,
  canChange: true,
}
export const ALERTS = { rules: [ALERT_BUILT_IN], canAdd: true }
