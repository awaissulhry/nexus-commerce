import type { ApprovalRule, KindsAnswer, RulesAnswer } from './api'
import type { ApprovalRulesModel, RuleDialogState } from './model'

/**
 * Made-up data for the design cases of Approval rules (B-W2b-307; PLAN §3.1): invented companies, roles, people and
 * records. Two rules of a purchase order (one on, signed 'Released' with a code), a price-change rule off, a rule of a
 * kind with no checker yet, and the locked rule.
 */

const at = (day: number, hour = 9) => new Date(Date.UTC(2026, 10, day, hour)).toISOString()
const id = (n: number) => `0190f0e2-3071-7000-8000-${String(n).padStart(12, '0')}`
const words = (en: string, it: string) => ({ en, it })
export const DEMO_COMPANY = { id: '0190f0e2-1111-7000-8000-000000000001', name: 'Demo Pelletteria S.r.l.' }

export const DEMO_KINDS: KindsAnswer = {
  kinds: [
    {
      kind: 'PURCHASE_ORDER',
      recordType: 'PurchaseOrder',
      label: words('Purchase order', "Ordine d'acquisto"),
      askable: true,
      fields: [
        { id: 'orderValue', label: words('order value', "valore dell'ordine"), kind: 'number', unit: null, grain: 'cost', options: [], min: 0, max: null, heldReason: null },
        { id: 'currency', label: words('currency', 'valuta'), kind: 'text', unit: null, grain: null, options: [], min: null, max: null, heldReason: null },
        { id: 'lineCount', label: words('lines', 'righe'), kind: 'number', unit: null, grain: null, options: [], min: 0, max: null, heldReason: null },
        {
          id: 'supplierStatus',
          label: words('supplier status', 'stato del fornitore'),
          kind: 'choice',
          unit: null,
          grain: null,
          options: [
            { value: 'PROSPECT', label: words('Prospect', 'Potenziale') },
            { value: 'ACTIVE', label: words('Active', 'Attivo') },
          ],
          min: null,
          max: null,
          heldReason: null,
        },
      ],
    },
  ],
  notRegistered: ['PRICE_CHANGE', 'STOCK_ADJUSTMENT'],
  meanings: [
    { meaning: 'REVIEWED', label: words('Reviewed', 'Revisionato') },
    { meaning: 'APPROVED', label: words('Approved', 'Approvato') },
    { meaning: 'RELEASED', label: words('Released', 'Rilasciato') },
    { meaning: 'VERIFIED', label: words('Verified', 'Verificato') },
  ],
  operators: ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'in', 'notIn', 'contains', 'isTrue', 'isFalse'],
}

const rule = (n: number, overrides: Partial<ApprovalRule> = {}): ApprovalRule => ({
  id: id(n),
  kind: 'PURCHASE_ORDER',
  kindLabel: words('Purchase order', "Ordine d'acquisto"),
  registered: true,
  name: 'Orders over 5,000',
  sentence: words("Purchase order: order value over 5000 → Finance, signed 'Released'", "Ordine d'acquisto: valore dell'ordine oltre 5000 → Finanza, firmato 'Rilasciato'"),
  companyId: DEMO_COMPANY.id,
  companyName: DEMO_COMPANY.name,
  condition: { combinator: 'and', rows: [{ id: 'r1', field: 'orderValue', operator: 'gt', value: '5000', held: false }] },
  approver: { kind: 'ROLE', id: id(900), name: 'Finance' },
  signatureMeaning: 'RELEASED',
  requireStepUp: true,
  sequence: 100,
  dueHours: 24,
  active: true,
  effectiveFrom: null,
  fired30Days: 7,
  changedBy: { id: id(901), name: 'Olga Titolare', me: false },
  updatedAt: at(10),
  canChange: true,
  heldReason: null,
  version: 3,
  ...overrides,
})

export const DEMO_APPROVAL_RULES: ApprovalRule[] = [
  rule(1),
  rule(2, { name: 'New suppliers', sentence: words('Purchase order: supplier status is Prospect → Purchasing manager', "Ordine d'acquisto: stato del fornitore è Potenziale → Responsabile acquisti"), condition: { combinator: 'and', rows: [{ id: 'r2', field: 'supplierStatus', operator: 'eq', value: 'PROSPECT', held: false }] }, approver: { kind: 'ROLE', id: id(902), name: 'Purchasing manager' }, signatureMeaning: null, requireStepUp: false, sequence: 50, dueHours: null, active: false, fired30Days: 0, version: 1 }),
  rule(3, { kind: 'PRICE_CHANGE', kindLabel: words('Price change', 'Cambio di prezzo'), registered: false, name: 'Price rises', sentence: words('Price change: every request → Finance', 'Cambio di prezzo: ogni richiesta → Finanza'), condition: { combinator: 'and', rows: [] }, signatureMeaning: null, requireStepUp: false, active: false, fired30Days: 0, companyId: null, companyName: null, version: 1 }),
]

export const DEMO_RULES_ANSWER: RulesAnswer = {
  asOf: at(12, 10),
  rules: DEMO_APPROVAL_RULES,
  fixed: [{ code: 'NO_SELF_APPROVAL', sentence: words('Nobody approves their own request, the Owner included.', 'Nessuno approva la propria richiesta, titolare compreso.') }],
  canAdd: true,
}

export function approvalRulesModel(overrides: Partial<ApprovalRulesModel> = {}): ApprovalRulesModel {
  return {
    rules: { status: 'ready', data: DEMO_RULES_ANSWER },
    kinds: { status: 'ready', data: DEMO_KINDS },
    roles: { status: 'ready', data: [{ id: id(900), name: 'Finance' }, { id: id(902), name: 'Purchasing manager' }, { id: id(903), name: 'Owner' }] },
    companies: [DEMO_COMPANY, { id: '0190f0e2-1111-7000-8000-000000000002', name: 'Demo Calzature S.p.A.' }],
    manage: true,
    offline: false,
    busy: false,
    saving: [],
    dialog: null,
    prefix: '/w/DEMO',
    ...overrides,
  }
}

export const DEMO_DIALOG: RuleDialogState = { mode: 'edit', rule: DEMO_APPROVAL_RULES[0]!, test: null, problem: null }
export const DEMO_TEST: RuleDialogState = {
  ...DEMO_DIALOG,
  test: {
    status: 'ready',
    data: {
      tested: 50,
      wouldAsk: 4,
      samples: [
        { record: { type: 'PurchaseOrder', id: id(501), label: 'PO-DEMO-0042 · Conceria Esempio' }, companyId: DEMO_COMPANY.id },
        { record: { type: 'PurchaseOrder', id: id(502), label: 'PO-DEMO-0039 · Tessitura Prova' }, companyId: DEMO_COMPANY.id },
      ],
      approvers: [{ id: id(910), name: 'Fiona Conti' }, { id: id(911), name: 'Marco Demo' }],
      sentence: words('Purchase order: order value over 5000 → Finance', "Ordine d'acquisto: valore dell'ordine oltre 5000 → Finanza"),
    },
  },
}
/** A rule whose threshold the reader's grains do not show: "…", and the rule is held for them. */
export const DEMO_HELD_RULE: ApprovalRule = { ...DEMO_APPROVAL_RULES[0]!, sentence: words("Purchase order: order value over … → Finance, signed 'Released'", "Ordine d'acquisto: valore dell'ordine oltre … → Finanza, firmato 'Rilasciato'"), condition: { combinator: 'and', rows: [{ id: 'r1', field: 'orderValue', operator: 'gt', value: null, held: true }] }, canChange: false, heldReason: 'A threshold in a grain you do not hold.' }
