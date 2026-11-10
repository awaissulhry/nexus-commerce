import { asMoney } from '@nexus/factory-domain/money/marked'
import { COMPANY_ID, NOW, ROLE_PERMISSIONS, uid, type RoleCase } from '../library/demo'
import { optionsCan, type GroupRecord, type GroupRow, type OptionEffect, type OptionRule, type OptionValue, type OptionsCan, type StyleOptions } from './model'

/**
 * Design-only made-up data of Options & rules (SCR-114, SCR-114-record; PLAN §3.1): an invented factory's option library —
 * DEMO- codes, invented materials, operations, minutes and surcharges, styles that do not exist. Nothing here is a real
 * company, customer, price or certificate.
 */

const w = (it: string, en: string) => ({ it, en })

export const row = (n: number, code: string, name: string, extra: Partial<GroupRow> = {}): GroupRow => ({
  id: uid('4242', n),
  code,
  name,
  nameI18n: null,
  description: null,
  companyId: null,
  kind: 'SINGLE',
  minPicks: 0,
  maxPicks: 1,
  picks: w('0–1', '0–1'),
  values: 3,
  styles: 2,
  rules: 0,
  outsideCertificate: 0,
  status: 'ACTIVE',
  version: 2,
  updatedAt: NOW,
  ...extra,
})

export const ROWS: GroupRow[] = [
  row(1, 'DEMO-ARMOUR', 'Paraschiena', { minPicks: 1, picks: w('1–1', '1–1'), values: 3, styles: 5, rules: 2, outsideCertificate: 1, description: 'Livello della protezione dorsale' }),
  row(2, 'DEMO-PERF', 'Perforazione', { values: 3, styles: 4, rules: 2, outsideCertificate: 1 }),
  row(3, 'DEMO-LINER', 'Fodera termica', { values: 2, styles: 3, rules: 1 }),
  row(4, 'DEMO-LOGO', 'Loghi ricamati', { kind: 'MULTI', maxPicks: null, picks: w('0–qualsiasi', '0–any'), values: 4, styles: 2, companyId: COMPANY_ID }),
  row(5, 'DEMO-NAME', 'Nome ricamato', { kind: 'FREE_TEXT', maxPicks: null, picks: w('0–qualsiasi', '0–any'), values: 1, styles: 1 }),
  row(6, 'DEMO-HUMP', 'Gobba aerodinamica', { values: 0, styles: 0 }),
  row(7, 'DEMO-COLLAR', 'Fodera del collo', { kind: 'MULTI', maxPicks: 2, picks: w('0–2', '0–2'), values: 2, styles: 0 }),
  row(8, 'DEMO-CUFF', 'Polsino vecchio', { values: 2, styles: 0, status: 'ARCHIVED', version: 4 }),
]
export const ACTIVE_ROWS = ROWS.filter((entry) => entry.status === 'ACTIVE')
export const COUNTS = { all: ACTIVE_ROWS.length, outsideCertificate: ACTIVE_ROWS.filter((entry) => entry.outsideCertificate > 0).length }

export const canOf = (role: RoleCase): OptionsCan => optionsCan(ROLE_PERMISSIONS[role])

// ---- the record: DEMO-PERF ------------------------------------------------------------------------------------------

const GROUP_ID = uid('4242', 2)
const LINER_ID = uid('4242', 3)
const value = (n: number, code: string, name: string, extra: Partial<OptionValue> = {}): OptionValue => ({
  id: uid('4243', n),
  groupId: GROUP_ID,
  code,
  name,
  nameI18n: null,
  seq: n * 10,
  freeText: false,
  freeTextMaxLength: null,
  freeTextPattern: null,
  outsideCertificate: false,
  effects: 0,
  usedBy: { lines: 0, steps: 0 },
  status: 'ACTIVE',
  version: 3,
  updatedAt: NOW,
  ...extra,
})

export const VALUES: OptionValue[] = [
  value(1, 'PERF-NONE', 'Senza perforazione'),
  value(2, 'PERF-FRONT', 'Pannelli frontali forati', { effects: 2, usedBy: { lines: 1, steps: 1 } }),
  value(3, 'PERF-FULL', 'Perforazione completa', { effects: 5, outsideCertificate: true, usedBy: { lines: 2, steps: 1 } }),
  value(4, 'PERF-OLD', 'Fori laser (vecchi)', { status: 'ARCHIVED', version: 5 }),
]

const ref = (n: number, code: string, name: string) => ({ id: uid('4244', n), code, name })
const MESH = ref(1, 'DEMO-MESH-01', 'Rete traspirante 3D')
const OP_PERF = ref(2, 'DEMO-OP-PERF', 'Foratura pannelli')
const LINER_CLOTH = ref(3, 'DEMO-LIN-TH', 'Imbottitura termica')

const effect = (n: number, valueN: number, extra: Partial<OptionEffect> & Pick<OptionEffect, 'kind' | 'words'>): OptionEffect => ({
  id: uid('4245', n),
  valueId: uid('4243', valueN),
  item: null,
  itemColourId: null,
  targetItem: null,
  qty: null,
  uom: null,
  sizeQuantities: null,
  section: null,
  operation: null,
  minutes: null,
  currency: null,
  note: null,
  updatedAt: NOW,
  ...extra,
})

export const EFFECTS: OptionEffect[] = [
  effect(1, 2, { kind: 'OPERATION_ADD', operation: OP_PERF, minutes: '3', words: w("Aggiunge l'operazione DEMO-OP-PERF (3 min)", 'Adds operation DEMO-OP-PERF (3 min)') }),
  effect(2, 2, { kind: 'PRICE', priceDelta: asMoney('price', '15'), currency: 'EUR', pricePct: asMoney('price', null), words: w('Cambia il prezzo', 'Moves the price') }),
  effect(3, 3, { kind: 'OPERATION_ADD', operation: OP_PERF, minutes: '6', words: w("Aggiunge l'operazione DEMO-OP-PERF (6 min)", 'Adds operation DEMO-OP-PERF (6 min)') }),
  effect(4, 3, { kind: 'BOM_ADD', item: MESH, uom: 'M2', qty: '0.22', sizeQuantities: { '48': '0.2', '50': '0.22', '52': '0.24' }, section: 'LINING', words: w('Aggiunge DEMO-MESH-01 0,22 M2 (per 3 taglie) · LINING', 'Adds DEMO-MESH-01 0.22 M2 (for 3 sizes) · LINING') }),
  effect(5, 3, { kind: 'BOM_REMOVE', targetItem: LINER_CLOTH, words: w('Toglie DEMO-LIN-TH', 'Leaves out DEMO-LIN-TH') }),
  effect(6, 3, { kind: 'PRICE', priceDelta: asMoney('price', null), currency: null, pricePct: asMoney('price', '10'), words: w('Cambia il prezzo', 'Moves the price') }),
  effect(7, 3, { kind: 'CERTIFICATE', note: "La resistenza all'abrasione delle zone forate non è coperta dall'esame UE del tipo.", words: w("Fuori certificato: la resistenza all'abrasione delle zone forate non è coperta dall'esame UE del tipo.", "Outside the certificate: la resistenza all'abrasione delle zone forate non è coperta dall'esame UE del tipo.") }),
]

const otherRef = (n: number, code: string, name: string) => ({ id: uid('4246', n), code, name, nameI18n: null, groupId: LINER_ID, groupCode: 'DEMO-LINER', groupName: 'Fodera termica', status: 'ACTIVE' as const })
const THERMAL = otherRef(1, 'LINER-THERM', 'Fodera termica staccabile')
const SUMMER = otherRef(2, 'LINER-MESH', 'Fodera estiva in rete')

const rule = (n: number, subject: string | null, other: ReturnType<typeof otherRef>, extra: Partial<OptionRule> & Pick<OptionRule, 'kind' | 'severity' | 'words' | 'broken'>): OptionRule => ({
  id: uid('4247', n),
  valueId: subject,
  when: { combinator: 'and', rows: [{ id: 'subject', field: 'option', operator: 'eq', value: subject ?? '*' }] },
  otherValueId: other.id,
  other,
  messageI18n: null,
  status: 'ACTIVE',
  version: 1,
  ...extra,
})

export const RULES: OptionRule[] = [
  rule(1, uid('4243', 3), THERMAL, {
    kind: 'EXCLUDES',
    severity: 'BLOCK',
    messageI18n: { it: 'La perforazione completa non va con la fodera termica.', en: 'Full perforation does not go with the thermal liner.' },
    words: w('Perforazione completa esclude Fodera termica staccabile — blocca', 'Perforazione completa excludes Fodera termica staccabile — block'),
    broken: w('La perforazione completa non va con la fodera termica.', 'Full perforation does not go with the thermal liner.'),
  }),
  rule(2, null, SUMMER, {
    kind: 'REQUIRES',
    severity: 'WARN',
    words: w('Qualsiasi opzione di Perforazione richiede Fodera estiva in rete — avviso', 'Any option of Perforazione requires Fodera estiva in rete — warning'),
    broken: w('Qualsiasi opzione di Perforazione vuole anche Fodera estiva in rete: sceglila.', 'Any option of Perforazione needs Fodera estiva in rete too: choose it.'),
  }),
]

const offer = (n: number, code: string, name: string, extra: Partial<GroupRecord['styles'][number]> = {}): GroupRecord['styles'][number] => ({
  id: uid('4248', n),
  style: { id: uid('4249', n), code, name, companyId: COMPANY_ID, status: 'ACTIVE' },
  seq: n * 10,
  minPicks: null,
  maxPicks: null,
  picks: w('0–1', '0–1'),
  defaultValueId: null,
  status: 'ACTIVE',
  version: 2,
  ...extra,
})

export const OFFERS: GroupRecord['styles'] = [
  offer(1, 'DEMO-JKT-01', 'Giacca touring Demo'),
  offer(2, 'DEMO-JKT-02', 'Giacca sport Demo', { minPicks: 1, picks: w('1–1', '1–1'), defaultValueId: uid('4243', 2) }),
  offer(3, 'DEMO-SUIT-01', 'Tuta pista Demo', { style: { id: uid('4249', 3), code: 'DEMO-SUIT-01', name: 'Tuta pista Demo', companyId: COMPANY_ID, status: 'DRAFT' } }),
  offer(4, 'DEMO-PANT-01', 'Pantalone Demo', { status: 'ARCHIVED', version: 3 }),
]

export const GROUP: GroupRecord = {
  ...ROWS[1]!,
  description: 'Fori nei pannelli per far passare aria',
  values: VALUES,
  rules: RULES,
  effects: EFFECTS,
  styles: OFFERS,
  subjectOptions: [
    { value: '*', code: null, words: w('Qualsiasi opzione di Perforazione', 'Any option of Perforazione'), status: 'ACTIVE' },
    ...VALUES.map((entry) => ({ value: entry.id, code: entry.code, words: w(entry.name, entry.name), status: entry.status })),
  ],
  counts: { values: 3, styles: 3, rules: 2, outsideCertificate: 1 },
  may: { manage: true, price: true },
}

/** The record as a reader without the price grain receives it: the surcharges' amounts are left out. */
export const withoutPrices = (group: GroupRecord): GroupRecord => ({
  ...group,
  effects: group.effects.map((entry) => {
    if (entry.kind !== 'PRICE') return entry
    const { priceDelta: _amount, pricePct: _percent, ...rest } = entry
    return rest as OptionEffect
  }),
  may: { ...group.may, price: false },
})

export const LINER_VALUES = [
  { id: THERMAL.id, code: THERMAL.code, name: THERMAL.name, status: 'ACTIVE' as const },
  { id: SUMMER.id, code: SUMMER.code, name: SUMMER.name, status: 'ACTIVE' as const },
]

export const STYLE_OPTIONS: StyleOptions = {
  style: { id: uid('4249', 1), code: 'DEMO-JKT-01', name: 'Giacca touring Demo', companyId: COMPANY_ID, status: 'ACTIVE' },
  offers: [
    {
      id: uid('4248', 1),
      group: { id: GROUP_ID, code: 'DEMO-PERF', name: 'Perforazione', nameI18n: null, kind: 'SINGLE', minPicks: 0, maxPicks: 1, status: 'ACTIVE' },
      seq: 10,
      minPicks: null,
      maxPicks: null,
      effective: { minPicks: 0, maxPicks: 1 },
      picks: w('0–1', '0–1'),
      defaultValueId: null,
      values: VALUES.map((entry) => ({ id: entry.id, code: entry.code, name: entry.name, nameI18n: null, seq: entry.seq, freeText: false, outsideCertificate: entry.outsideCertificate, status: entry.status })),
      status: 'ACTIVE',
      version: 2,
      updatedAt: NOW,
    },
    {
      id: uid('4248', 9),
      group: { id: uid('4242', 1), code: 'DEMO-ARMOUR', name: 'Paraschiena', nameI18n: null, kind: 'SINGLE', minPicks: 1, maxPicks: 1, status: 'ACTIVE' },
      seq: 20,
      minPicks: null,
      maxPicks: null,
      effective: { minPicks: 1, maxPicks: 1 },
      picks: w('1–1', '1–1'),
      defaultValueId: null,
      values: [
        { id: uid('4250', 1), code: 'ARM-L1', name: 'Livello 1', nameI18n: null, seq: 10, freeText: false, outsideCertificate: false, status: 'ACTIVE' },
        { id: uid('4250', 2), code: 'ARM-L2', name: 'Livello 2', nameI18n: null, seq: 20, freeText: false, outsideCertificate: false, status: 'ACTIVE' },
        { id: uid('4250', 3), code: 'ARM-NONE', name: 'Senza paraschiena', nameI18n: null, seq: 30, freeText: false, outsideCertificate: true, status: 'ACTIVE' },
      ],
      status: 'ACTIVE',
      version: 1,
      updatedAt: NOW,
    },
  ],
  lines: [
    { revision: { id: uid('4251', 2), revision: 2, status: 'DRAFT' }, lineId: uid('4252', 1), seq: 40, item: MESH, optionValueId: uid('4243', 3), option: 'DEMO-PERF: PERF-FULL' },
    { revision: { id: uid('4251', 1), revision: 1, status: 'RELEASED' }, lineId: uid('4252', 2), seq: 40, item: MESH, optionValueId: uid('4243', 3), option: 'DEMO-PERF: PERF-FULL' },
  ],
  steps: [{ revision: { id: uid('4251', 2), revision: 2, status: 'DRAFT' }, stepId: uid('4253', 1), seq: 20, code: OP_PERF.code, name: OP_PERF.name, optionValueIds: [uid('4243', 2), uid('4243', 3)], options: ['DEMO-PERF: PERF-FRONT', 'DEMO-PERF: PERF-FULL'] }],
  editable: true,
}
