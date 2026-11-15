import type { DuplicateCandidate, DuplicatePair, ImportDuplicates, MergePreview } from './api'
import type { MergeAsk } from './model'

/**
 * Made-up data for the design screens of likely duplicates (SCR-620 … SCR-623): invented codes, names, domains and
 * counts ("Demo", example domains), never a real business, person or number.
 */

const uid = (n: number) => `0190f0e2-4270-7000-8000-${String(n).padStart(12, '0')}`
export const PREFIX = '/w/DEMO'
const company = uid(99)
const created = (day: number) => new Date(Date.UTC(2026, 9, day, 9, 30)).toISOString()

const party = (n: number, code: string, name: string, extra: Partial<DuplicateCandidate> = {}): DuplicateCandidate => ({
  recordType: 'PARTY',
  id: uid(n),
  code,
  name,
  status: 'ACTIVE',
  companyId: null,
  roles: ['CUSTOMER'],
  kind: null,
  likelihood: 'HIGH',
  reasons: [],
  ...extra,
})
const material = (n: number, code: string, name: string, extra: Partial<DuplicateCandidate> = {}): DuplicateCandidate => ({
  recordType: 'MATERIAL',
  id: uid(n),
  code,
  name,
  status: 'ACTIVE',
  companyId: company,
  roles: [],
  kind: 'LEATHER',
  likelihood: 'HIGH',
  reasons: [],
  ...extra,
})

export const ROSSI = party(1, 'C-0001', 'Pelletteria Demo Rossi S.r.l.', { reasons: [{ code: 'SAME_NAME', detail: null, score: null }, { code: 'SAME_EMAIL_DOMAIN', detail: 'rossi-demo.example', score: null }] })
export const ROSSI_VAT = party(1, 'C-0001', 'Pelletteria Demo Rossi S.r.l.', { reasons: [{ code: 'SAME_VAT_NUMBER', detail: null, score: null }, { code: 'SAME_NAME', detail: null, score: null }] })
export const BIANCHI = party(2, 'C-0014', 'Bianchi Moto Demo', { likelihood: 'MEDIUM', status: 'PROSPECT', reasons: [{ code: 'SIMILAR_NAME', detail: null, score: 86 }] })
export const NAPPA = material(10, 'PEL-NAP-01', 'Vitello nappa demo nero', { reasons: [{ code: 'SAME_CODE', detail: null, score: null }, { code: 'SAME_SUPPLIER_CODE', detail: null, score: null }] })
export const NAPPA_OLD = material(11, 'PEL-NAP-OLD', 'Vitello nappa demo', { likelihood: 'MEDIUM', status: 'ARCHIVED', reasons: [{ code: 'SIMILAR_NAME', detail: null, score: 88 }] })

const side = (candidate: DuplicateCandidate, day: number) => {
  const { likelihood: _likelihood, reasons: _reasons, ...rest } = candidate
  return { ...rest, createdAt: created(day) }
}

export const PARTY_PAIRS: DuplicatePair[] = [
  { key: `${uid(1)}:${uid(3)}`, a: side(ROSSI, 2), b: side(party(3, 'C-0102', 'PELLETTERIA DEMO ROSSI SRL'), 20), likelihood: 'HIGH', reasons: ROSSI.reasons },
  { key: `${uid(4)}:${uid(5)}`, a: side(party(4, 'F-0007', 'Conceria Demo del Ponte S.p.A.', { roles: ['SUPPLIER'] }), 3), b: side(party(5, 'F-0031', 'Conceria Demo Del Ponte', { roles: ['SUPPLIER', 'SUBCONTRACTOR'] }), 22), likelihood: 'HIGH', reasons: [{ code: 'SAME_FISCAL_CODE', detail: null, score: null }, { code: 'SAME_NAME', detail: null, score: null }] },
  { key: `${uid(2)}:${uid(6)}`, a: side(BIANCHI, 5), b: side(party(6, 'C-0120', 'Bianchi Moto Demo Racing'), 25), likelihood: 'MEDIUM', reasons: [{ code: 'SIMILAR_NAME', detail: null, score: 86 }, { code: 'SAME_WEBSITE', detail: 'bianchi-demo.example', score: null }] },
  { key: `${uid(7)}:${uid(8)}`, a: side(party(7, 'C-0040', 'Rider Demo Club'), 6), b: side(party(8, 'C-0141', 'Rider Demo Club Italia', { status: 'BLOCKED' }), 26), likelihood: 'MEDIUM', reasons: [{ code: 'SAME_EMAIL_DOMAIN', detail: 'riderclub-demo.example', score: null }] },
]

export const MATERIAL_PAIRS: DuplicatePair[] = [
  { key: `${uid(10)}:${uid(12)}`, a: side(NAPPA, 1), b: side(material(12, 'PELNAP01', 'Vitello Nappa Demo Nero'), 18), likelihood: 'HIGH', reasons: [{ code: 'SAME_CODE', detail: null, score: null }, { code: 'SAME_SUPPLIER_CODE', detail: null, score: null }, { code: 'SAME_NAME', detail: null, score: null }] },
  { key: `${uid(13)}:${uid(14)}`, a: side(material(13, 'ZIP-DEMO-60', 'Cerniera demo 60 cm', { kind: 'TRIM' }), 4), b: side(material(14, 'ZIP-DEMO-60B', 'Cerniera demo 60cm', { kind: 'TRIM' }), 21), likelihood: 'MEDIUM', reasons: [{ code: 'SIMILAR_NAME', detail: null, score: 94 }] },
]

const counts = (contacts = 0, addresses = 0, taxIdentities = 0, colours = 0) => ({ contacts, addresses, taxIdentities, colours })
const mergeSide = (candidate: DuplicateCandidate, version: number) => ({ id: candidate.id, code: candidate.code, name: candidate.name, status: candidate.status, companyId: candidate.companyId, version, kind: candidate.kind, roles: candidate.roles })

export const ASK: MergeAsk = { recordType: 'PARTY', kept: { id: uid(1), code: 'C-0001' }, dropped: { id: uid(3), code: 'C-0102' } }
const DROPPED = party(3, 'C-0102', 'PELLETTERIA DEMO ROSSI SRL')

export const PREVIEW_OK: MergePreview = { recordType: 'PARTY', kept: mergeSide(ROSSI, 7), dropped: mergeSide(DROPPED, 2), refusals: [], uses: [], moves: counts(2, 1, 1), stays: counts(1), reverseWorks: false }
export const PREVIEW_NOTHING: MergePreview = { ...PREVIEW_OK, moves: counts(), stays: counts() }
export const PREVIEW_IN_USE: MergePreview = {
  ...PREVIEW_OK,
  refusals: ['IN_USE'],
  uses: [
    { group: 'SALES', count: 3, tables: ['Quote', 'SalesOrder'] },
    { group: 'MONEY', count: 1, tables: ['Invoice'] },
  ],
  reverseWorks: true,
}
export const PREVIEW_BOTH_USED: MergePreview = { ...PREVIEW_IN_USE, reverseWorks: false }
export const PREVIEW_ARCHIVED: MergePreview = { ...PREVIEW_OK, kept: { ...mergeSide(ROSSI, 7), status: 'ARCHIVED' }, refusals: ['KEPT_ARCHIVED', 'OTHER_COMPANY'] }
export const PREVIEW_MATERIAL: MergePreview = {
  recordType: 'MATERIAL',
  kept: mergeSide(NAPPA, 4),
  dropped: mergeSide(material(12, 'PELNAP01', 'Vitello Nappa Demo Nero'), 1),
  refusals: [],
  uses: [],
  moves: counts(0, 0, 0, 2),
  stays: counts(0, 0, 0, 1),
  reverseWorks: false,
}

const row = (rowNumber: number, key: string, name: string, extra: Partial<ImportDuplicates['rows'][number]> = {}) => ({ rowNumber, key, name, recordId: null, candidates: [], sameSheet: [], ...extra })

export const IMPORT_CHECK: ImportDuplicates = {
  jobId: uid(50),
  importerKey: 'parties.parties',
  supported: true,
  recordType: 'PARTY',
  checked: 120,
  more: false,
  rows: [
    row(4, 'C-0102', 'PELLETTERIA DEMO ROSSI SRL', { candidates: [ROSSI] }),
    row(9, 'C-0120', 'Bianchi Moto Demo Racing', { candidates: [BIANCHI] }),
    row(17, 'C-0131', 'Nuovo Cliente Demo S.r.l.', { sameSheet: [{ rowNumber: 12, key: 'C-0126', recordId: null, likelihood: 'HIGH', reasons: [{ code: 'SAME_NAME', detail: null, score: null }, { code: 'SAME_EMAIL_DOMAIN', detail: 'nuovo-demo.example', score: null }] }] }),
  ],
}

export const IMPORT_RESULT: ImportDuplicates = {
  ...IMPORT_CHECK,
  rows: IMPORT_CHECK.rows.map((entry, index) => ({ ...entry, recordId: uid(60 + index), sameSheet: entry.sameSheet.map((other) => ({ ...other, recordId: uid(70) })) })),
}

export const IMPORT_MORE: ImportDuplicates = { ...IMPORT_CHECK, checked: 500, more: true }
