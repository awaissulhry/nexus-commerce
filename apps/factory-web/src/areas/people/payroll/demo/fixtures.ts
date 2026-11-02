import { CODE_MEANINGS, EARNING_CODES, HOUR_CODES } from '@nexus/factory-domain/people/payroll/codes'
import { STARTERS } from '@nexus/factory-domain/people/payroll/layouts'
import { COMPANY, SITE_N, SITE_S } from '../../_shared/fixtures'
import type { Check, CheckCode, CodeRow, ExportFile, ExportLink, ExportRecord, ExportRow, Layout, LayoutsAnswer, PayrollMonth, PayrollValues, ShowAnswer } from '../api'

/**
 * Made-up data of Payroll export (SCR-159): a demo company, made-up employee codes and provider codes, no real consultant, no real
 * layout (the Zucchetti starter is the domain's own made-up shape).
 */

const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const COMPANY_REF = { code: 'DEMO', legalName: 'Officina Demo S.r.l.' }
const SEAL_1 = '9f2c4e1ab7d05c38e61f4a2b90c7d3e85a1b6f04c2d97e13b8a05f6d4c1e7a92'
const SEAL_2 = '3b7e90d1c4a2f8665e13d7a9b0c2f41e86d5a7c3190be2f4d8a6c1750e9b3f24'

export const layoutOf = (over: Partial<Layout> & Pick<Layout, 'name' | 'format'>): Layout => ({
  id: uid('6001', 1),
  companyId: COMPANY,
  provider: null,
  definition: STARTERS.GENERIC_CSV.definition as Layout['definition'],
  status: 'ACTIVE',
  note: null,
  confirmed: true,
  updatedAt: '2026-10-01T08:00:00.000Z',
  version: 1,
  ...over,
})

export const LAYOUT_CSV = layoutOf({ name: 'CSV generico', format: 'DELIMITED' })
export const LAYOUT_EXCEL = layoutOf({ id: uid('6001', 2), name: 'Excel generico', format: 'SPREADSHEET', definition: STARTERS.GENERIC_EXCEL.definition as Layout['definition'] })
export const LAYOUT_ZUCCHETTI = layoutOf({ id: uid('6001', 3), name: 'Importazione Zucchetti', format: 'FIXED_WIDTH', provider: 'Zucchetti', confirmed: false, definition: STARTERS.ZUCCHETTI.definition as Layout['definition'] })
export const LAYOUT_CONFIRMED = layoutOf({ ...LAYOUT_ZUCCHETTI, name: 'Tracciato consulente', confirmed: true, definition: { ...(STARTERS.ZUCCHETTI.definition as Layout['definition']), companyCode: '000123', confirmation: { on: '2026-10-20', by: 'Studio Demo' } } })

export const LAYOUTS: LayoutsAnswer = {
  companyId: COMPANY,
  layouts: [LAYOUT_CSV, LAYOUT_EXCEL, LAYOUT_ZUCCHETTI],
  starters: (['GENERIC_CSV', 'GENERIC_EXCEL', 'ZUCCHETTI'] as const).map((key) => ({ key, name: STARTERS[key].name, format: STARTERS[key].format, provider: STARTERS[key].provider })),
}

const PLACE: Readonly<Record<CheckCode, Check['place']>> = { MONTH_CLOSED: 'ATTENDANCE', EMPLOYEE_CODES: 'EMPLOYEES', DAYS_APPROVED: 'ATTENDANCE', ANOMALIES_CLEARED: 'ATTENDANCE', PRODUCTION_DAYS: 'PRODUCTION_LABOUR', PAY_PERIOD_LOCKED: 'PIECE_RATES', CODES_MAPPED: 'CODE_MAPPING', LAYOUT_FITS: 'LAYOUTS', AGENCY_LEFT_OUT: 'EMPLOYEES', LEAVERS: 'EMPLOYEES', NOT_ON_FILE: 'EMPLOYEES', LAYOUT_NOT_CONFIRMED: 'LAYOUTS' }
const WARNINGS: readonly CheckCode[] = ['AGENCY_LEFT_OUT', 'LEAVERS', 'NOT_ON_FILE', 'LAYOUT_NOT_CONFIRMED']

/** Every check; `open` gives the count of those that do not pass. */
export const checksOf = (open: Partial<Record<CheckCode, number>> = {}): Check[] =>
  (Object.keys(PLACE) as CheckCode[]).map((code) => ({ code, blocking: !WARNINGS.includes(code), passed: !open[code], count: open[code] ?? 0, place: PLACE[code] }))

export const rowOf = (over: Partial<ExportRow> = {}): ExportRow => ({
  id: uid('6002', 1),
  companyId: COMPANY,
  company: COMPANY_REF,
  month: '2026-09',
  number: 'PAY-2026-0009',
  revision: 1,
  status: 'EXPORTED',
  correctionOfId: null,
  correctedById: null,
  layout: { id: LAYOUT_CSV.id, name: LAYOUT_CSV.name, format: 'DELIMITED', provider: null, confirmed: true },
  madeBy: { id: uid('6003', 1), name: 'Anna Esempio' },
  createdAt: '2026-10-03T09:12:00.000Z',
  exportedAt: '2026-10-03T09:12:30.000Z',
  seal: SEAL_1,
  sentTo: ['studio@example.com'],
  downloadedAt: '2026-10-04T07:12:00.000Z',
  changed: null,
  version: 2,
  ...over,
})

export const EXPORTS: ExportRow[] = [
  rowOf({ id: uid('6002', 3), month: '2026-09', number: 'PAY-2026-0010', revision: 2, correctionOfId: uid('6002', 2), seal: SEAL_2, sentTo: [], downloadedAt: null, changed: { people: 3, values: 7 }, exportedAt: '2026-10-09T15:40:00.000Z', createdAt: '2026-10-09T15:39:00.000Z' }),
  rowOf({ id: uid('6002', 2), month: '2026-09', correctedById: uid('6002', 3), layout: { id: LAYOUT_CSV.id, name: LAYOUT_CSV.name, format: 'DELIMITED', provider: null, confirmed: true } }),
  rowOf({ id: uid('6002', 1), month: '2026-08', number: 'PAY-2026-0008', layout: { id: LAYOUT_ZUCCHETTI.id, name: LAYOUT_ZUCCHETTI.name, format: 'FIXED_WIDTH', provider: 'Zucchetti', confirmed: false }, seal: SEAL_2 }),
  rowOf({ id: uid('6002', 4), month: '2026-07', number: null, status: 'DRAFT', seal: null, sentTo: [], downloadedAt: null, exportedAt: null, createdAt: '2026-08-05T10:00:00.000Z' }),
  rowOf({ id: uid('6002', 5), month: '2026-06', number: null, status: 'CANCELLED', seal: null, sentTo: [], downloadedAt: null, exportedAt: null, createdAt: '2026-07-04T10:00:00.000Z' }),
]

const sites = [
  { siteId: SITE_N.id, code: SITE_N.code, name: SITE_N.name, gateOpen: true },
  { siteId: SITE_S.id, code: SITE_S.code, name: SITE_S.name, gateOpen: false },
]

export const monthOf = (over: Partial<PayrollMonth> = {}): PayrollMonth => ({
  companyId: COMPANY,
  company: COMPANY_REF,
  month: '2026-10',
  sites,
  state: 'NOT_EXPORTED',
  close: { state: 'CLOSED', closeId: uid('6004', 1) },
  checks: checksOf({ AGENCY_LEFT_OUT: 2, LEAVERS: 1 }),
  blocking: 0,
  people: 42,
  piecePayOn: true,
  payPeriodId: uid('6005', 1),
  latest: null,
  correction: null,
  carriesPay: true,
  actions: { export: { allowed: true }, correct: { allowed: false }, preview: { allowed: true } },
  ...over,
})

export const MONTH = monthOf()
export const MONTH_OPEN = monthOf({ close: { state: 'OPEN', closeId: null }, blocking: 2, checks: checksOf({ MONTH_CLOSED: 1, DAYS_APPROVED: 12, AGENCY_LEFT_OUT: 2 }), actions: { export: { allowed: false }, correct: { allowed: false }, preview: { allowed: true } } })
export const MONTH_HELD = monthOf({ blocking: 4, checks: checksOf({ EMPLOYEE_CODES: 1, ANOMALIES_CLEARED: 3, PAY_PERIOD_LOCKED: 1, CODES_MAPPED: 2, AGENCY_LEFT_OUT: 2, LEAVERS: 1, NOT_ON_FILE: 1 }), actions: { export: { allowed: false }, correct: { allowed: false }, preview: { allowed: true } } })
export const MONTH_EXPORTED = monthOf({ month: '2026-09', state: 'EXPORTED', latest: EXPORTS[0]!, correction: { people: 0, values: 0, corrections: 0 }, actions: { export: { allowed: false }, correct: { allowed: false }, preview: { allowed: true } } })
export const MONTH_PENDING = monthOf({ month: '2026-09', state: 'CORRECTION_PENDING', latest: EXPORTS[0]!, correction: { people: 3, values: 7, corrections: 2 }, actions: { export: { allowed: false }, correct: { allowed: true }, preview: { allowed: true } } })

const code = (n: number, over: Partial<CodeRow> & Pick<CodeRow, 'kind' | 'ourCode' | 'meaning'>): CodeRow => ({ id: uid('6006', n), providerCode: `V${String(n).padStart(3, '0')}`, inUse: true, updatedAt: '2026-10-02T10:20:00.000Z', version: 1, ...over })
export const CODES: CodeRow[] = [
  code(20, { kind: 'ABSENCE', ourCode: 'FERIE', meaning: 'Ferie', id: null, providerCode: null, updatedAt: null, version: null }),
  code(21, { kind: 'EARNING', ourCode: 'TEAM_SHARE', meaning: CODE_MEANINGS.TEAM_SHARE.en, id: null, providerCode: null, updatedAt: null, version: null }),
  ...HOUR_CODES.map((entry, index) => code(index + 1, { kind: 'HOUR', ourCode: entry, meaning: CODE_MEANINGS[entry].en })),
  code(10, { kind: 'ABSENCE', ourCode: 'MALATTIA', meaning: 'Malattia' }),
  ...EARNING_CODES.filter((entry) => entry !== 'TEAM_SHARE').map((entry, index) => code(index + 11, { kind: 'EARNING', ourCode: entry, meaning: CODE_MEANINGS[entry].en })),
  code(30, { kind: 'ABSENCE', ourCode: 'VECCHIO', meaning: 'Codice vecchio', inUse: false }),
]

const hours = (hourCode: 'ORD' | 'OT_DAY' | 'NIGHT', quantity: string): PayrollValues['people'][number]['cells'][number] => ({ kind: 'HOUR', code: hourCode, providerCode: 'V001', meaning: CODE_MEANINGS[hourCode].en, unit: 'HOURS', quantity, minutes: Math.round(Number(quantity) * 60), amount: null, currency: null })
const absence = (quantity: string): PayrollValues['people'][number]['cells'][number] => ({ kind: 'ABSENCE', code: 'FERIE', providerCode: 'A01', meaning: 'Ferie', unit: 'HOURS', quantity, minutes: Math.round(Number(quantity) * 60), amount: null, currency: null })
const earning = (earningCode: 'PIECE' | 'MAKE_UP', amount: number): PayrollValues['people'][number]['cells'][number] => ({ kind: 'EARNING', code: earningCode, providerCode: 'E01', meaning: CODE_MEANINGS[earningCode].en, unit: null, quantity: null, minutes: null, amount, currency: 'EUR' })

export const VALUES: PayrollValues = {
  month: '2026-10',
  people: [
    { employeeId: uid('6007', 1), employeeCode: 'D-0001', lastDay: null, cells: [hours('ORD', '168.00'), hours('OT_DAY', '6.50'), hours('NIGHT', '8.00'), earning('PIECE', 41250)] },
    { employeeId: uid('6007', 2), employeeCode: 'D-0002', lastDay: null, cells: [hours('ORD', '152.00'), absence('16.00'), earning('PIECE', 38400), earning('MAKE_UP', 1250)] },
    { employeeId: uid('6007', 3), employeeCode: 'D-0003', lastDay: '2026-10-30', cells: [hours('ORD', '160.00')] },
  ],
  sums: [
    { kind: 'HOUR', code: 'ORD', providerCode: 'V001', meaning: CODE_MEANINGS.ORD.en, unit: 'HOURS', quantity: '480.00', amount: null, currency: null, people: 3 },
    { kind: 'HOUR', code: 'OT_DAY', providerCode: 'V002', meaning: CODE_MEANINGS.OT_DAY.en, unit: 'HOURS', quantity: '6.50', amount: null, currency: null, people: 1 },
    { kind: 'ABSENCE', code: 'FERIE', providerCode: 'A01', meaning: 'Ferie', unit: 'HOURS', quantity: '16.00', amount: null, currency: null, people: 1 },
    { kind: 'EARNING', code: 'PIECE', providerCode: 'E01', meaning: CODE_MEANINGS.PIECE.en, unit: null, quantity: null, amount: 79650, currency: 'EUR', people: 2 },
  ],
  changes: null,
  payShown: true,
}

export const VALUES_NO_PAY: PayrollValues = {
  ...VALUES,
  payShown: false,
  people: VALUES.people.map((person) => ({ ...person, cells: person.cells.map(({ amount: _amount, ...cell }) => cell) })),
  sums: VALUES.sums.map(({ amount: _amount, ...sum }) => sum),
}

export const VALUES_CORRECTION: PayrollValues = {
  ...VALUES,
  month: '2026-09',
  changes: {
    people: 2,
    values: 3,
    rows: [
      { employeeCode: 'D-0001', kind: 'HOUR', code: 'ORD', meaning: CODE_MEANINGS.ORD.en, unit: 'HOURS', change: 'CHANGED', fromQuantity: '160.00', toQuantity: '168.00', fromAmount: null, toAmount: null, fromProviderCode: 'V001', toProviderCode: 'V001', currency: null },
      { employeeCode: 'D-0002', kind: 'ABSENCE', code: 'FERIE', meaning: 'Ferie', unit: 'HOURS', change: 'ADDED', fromQuantity: null, toQuantity: '16.00', fromAmount: null, toAmount: null, fromProviderCode: null, toProviderCode: 'A01', currency: null },
      { employeeCode: 'D-0002', kind: 'EARNING', code: 'MAKE_UP', meaning: CODE_MEANINGS.MAKE_UP.en, unit: null, change: 'CHANGED', fromQuantity: null, toQuantity: null, fromAmount: 1000, toAmount: 1250, fromProviderCode: 'E02', toProviderCode: 'E02', currency: 'EUR' },
    ],
  },
}

export const SHOW_PEOPLE: ShowAnswer = {
  code: 'EMPLOYEE_CODES',
  place: 'EMPLOYEES',
  people: [
    { employeeId: uid('6008', 1), name: 'Elena Fittizia', employeeCode: null, lastDay: null },
    { employeeId: uid('6008', 2), name: 'Marta Saggio', employeeCode: null, lastDay: '2026-10-30' },
  ],
  codes: [],
}
export const SHOW_CODES: ShowAnswer = {
  code: 'CODES_MAPPED',
  place: 'CODE_MAPPING',
  people: [],
  codes: [
    { kind: 'ABSENCE', ourCode: 'FERIE', meaning: 'Ferie' },
    { kind: 'EARNING', ourCode: 'TEAM_SHARE', meaning: CODE_MEANINGS.TEAM_SHARE.en },
  ],
}

const fileOf = (n: number, over: Partial<ExportFile> & Pick<ExportFile, 'kind' | 'name'>): ExportFile => ({ id: uid('6009', n), seq: n, format: over.kind === 'DATA' ? 'CSV' : 'PDF', rowCount: 96, contentType: over.kind === 'DATA' ? 'text/csv' : 'application/pdf', sizeBytes: over.kind === 'DATA' ? 4812 : 18244, sha256: SEAL_2, ...over })
export const FILES: ExportFile[] = [fileOf(1, { kind: 'DATA', name: 'PAGHE_DEMO_2026-09_v2.csv' }), fileOf(2, { kind: 'SUMMARY', name: 'PAGHE_DEMO_2026-09_v2_riepilogo.pdf', rowCount: 3 })]

const link = (n: number, over: Partial<ExportLink> = {}): ExportLink => ({ id: uid('6010', n), email: 'studio@example.com', state: 'LIVE', expiresAt: '2026-11-09T09:00:00.000Z', maxUses: 10, uses: 0, revokedAt: null, createdAt: '2026-11-02T09:00:00.000Z', downloads: [], ...over })

export const recordOf = (over: Partial<ExportRecord> = {}): ExportRecord => ({
  ...EXPORTS[0]!,
  payPeriodId: uid('6005', 1),
  checks: checksOf({ AGENCY_LEFT_OUT: 2, LEAVERS: 1 }).map(({ code: checkCode, blocking, passed, count }) => ({ code: checkCode, blocking, passed, count })),
  files: FILES,
  links: [link(1, { uses: 1, downloads: [{ at: '2026-11-02T14:12:00.000Z', fileId: FILES[0]!.id }] }), link(2, { state: 'REVOKED', revokedAt: '2026-11-01T09:00:00.000Z', email: 'vecchio@example.com' })],
  cancelledAt: null,
  cancelReason: null,
  note: null,
  carriesPay: true,
  actions: { correct: { allowed: true }, cancel: { allowed: false }, send: { allowed: true }, open: { allowed: true } },
  ...over,
})

export const RECORD = recordOf({ sentTo: ['studio@example.com'], downloadedAt: '2026-11-02T14:12:00.000Z' })
