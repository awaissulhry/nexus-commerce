import type { LogEntry, Person, Report, ReportAction, ReportCounts, ReportRow, Revision } from '../api'
import { safetyCan, type SafetyCan } from '../model'

/**
 * Made-up data for SCR-421 (safety reports and a report) and SCR-422 (the accident log), B-W2b-357: made-up reports PSR-DEMO-…,
 * made-up garments, places and words, made-up office people. Never a real customer, rider, person or number.
 */

export const PREFIX = '/w/DEMO'
export const TODAY = '2026-11-12'
export const AS_OF = '2026-11-12T09:42:00Z'

const id = (n: number) => `0190f0e2-3570-7000-8000-${String(n).padStart(12, '0')}`
export const COMPANY = id(900)

export const PEOPLE: Person[] = [
  { id: id(801), name: 'Giulia Demo (qualità)' },
  { id: id(802), name: 'Marco Esempio (vendite)' },
]

const ALL_SAFETY = ['sales.safety.view', 'sales.safety.manage', 'sales.safety.injury', 'sales.safety.log', 'sales.service.manage', 'sales.service.view', 'compliance.register.view', 'compliance.register.manage', 'parties.view', 'product.styles.view']
export const ROLE_PERMISSIONS = {
  inspector: ALL_SAFETY,
  sales: ['sales.safety.view', 'sales.safety.manage', 'sales.service.manage', 'sales.service.view', 'parties.view', 'product.styles.view'],
  production: ['sales.safety.view', 'compliance.register.view'],
  readOnly: ['sales.safety.view', 'compliance.register.view'],
  warehouse: ['inventory.stock.view'],
} as const satisfies Record<string, readonly string[]>
export const canOf = (role: keyof typeof ROLE_PERMISSIONS): SafetyCan => safetyCan(ROLE_PERMISSIONS[role])

const style = { id: id(701), code: 'GIA-DEMO-01', name: 'Giacca Demo Touring' }
const style2 = { id: id(702), code: 'PAN-DEMO-02', name: 'Pantalone Demo Pista' }
const party = { id: id(601), code: 'C-DEMO-01', legalName: 'Moto Demo S.r.l.' }

export const ROWS: ReportRow[] = [
  { id: id(1), number: 'PSR-DEMO-0001', companyId: COMPANY, source: 'PUBLIC_LINK', receivedAt: '2026-11-12T07:15:00Z', status: 'NEW', seen: false, party: null, style, serial: null, garmentSerial: null, batchNumber: 'L-2231', garmentBatch: 'L-2231', size: '52', occurredOn: '2026-11-08', case: { id: id(101), number: 'SVC-DEMO-0011', status: 'NEW' }, filed: false, accident: { outcome: 'NOT_KNOWN', told: false, mustTell: false }, ownerId: null, version: 1 },
  { id: id(2), number: 'PSR-DEMO-0002', companyId: COMPANY, source: 'PORTAL', receivedAt: '2026-11-11T15:02:00Z', status: 'ASSESSING', seen: true, party, style: style2, serial: 'SN-DEMO-000456', garmentSerial: 'SN-DEMO-000456', batchNumber: null, garmentBatch: 'L-2240', size: '50', occurredOn: '2026-11-09', case: { id: id(102), number: 'SVC-DEMO-0012', status: 'OPEN' }, filed: true, accident: { outcome: 'SERIOUS_HARM', told: false, mustTell: true }, ownerId: id(801), version: 4 },
  { id: id(3), number: 'PSR-DEMO-0003', companyId: COMPANY, source: 'MAIL', receivedAt: '2026-11-06T10:30:00Z', status: 'ASSESSING', seen: true, party, style, serial: 'X-123-TYPED', garmentSerial: null, batchNumber: null, garmentBatch: null, size: null, occurredOn: null, case: { id: id(103), number: 'SVC-DEMO-0009', status: 'OPEN' }, filed: false, accident: null, ownerId: id(802), version: 2 },
  { id: id(4), number: 'PSR-DEMO-0004', companyId: COMPANY, source: 'OFFICE', receivedAt: '2026-10-28T09:00:00Z', status: 'CLOSED', seen: true, party: null, style, serial: 'SN-DEMO-000123', garmentSerial: 'SN-DEMO-000123', batchNumber: null, garmentBatch: 'L-2231', size: '52', occurredOn: '2026-10-25', case: { id: id(104), number: 'SVC-DEMO-0004', status: 'CLOSED' }, filed: true, accident: { outcome: 'MINOR_HARM', told: false, mustTell: false }, ownerId: id(801), version: 6 },
]

export const COUNTS: ReportCounts = { tiles: { notSeen: 1, assessing: 2, accidentsToTell: 1 }, rows: { open: 3, new: 1, assessing: 2, closed: 1, all: 4 }, asOf: AS_OF }

const revision = (n: number, over: Partial<Revision> = {}): Revision => ({
  id: id(200 + n),
  revision: n,
  occurredOn: '2026-11-09',
  place: 'Circuito di prova, curva 3 (inventato)',
  styleId: style2.id,
  serial: 'SN-DEMO-000456',
  batchNumber: 'L-2240',
  outcome: 'NOT_KNOWN',
  authority: null,
  note: null,
  recordedAt: '2026-11-11T15:02:00Z',
  recordedById: null,
  ...over,
})

export const REVISIONS: Revision[] = [
  revision(2, { outcome: 'SERIOUS_HARM', note: 'Il cliente ha mandato il referto: frattura (inventato).', recordedAt: '2026-11-12T08:10:00Z', recordedById: id(801) }),
  revision(1),
]

export const LOG: LogEntry[] = [
  { ...revision(2, { outcome: 'SERIOUS_HARM', note: 'Referto ricevuto (inventato).', recordedAt: '2026-11-12T08:10:00Z', recordedById: id(801) }), reportId: id(2), companyId: COMPANY, number: 'PSR-DEMO-0002', reportStatus: 'ASSESSING', style: style2, revisions: 2, mustTell: true },
  { ...revision(1, { id: id(211), occurredOn: '2026-11-08', place: 'Strada provinciale, curva in discesa (inventato)', styleId: style.id, serial: null, batchNumber: 'L-2231' }), reportId: id(1), companyId: COMPANY, number: 'PSR-DEMO-0001', reportStatus: 'NEW', style, revisions: 1, mustTell: false },
  {
    ...revision(3, { id: id(212), occurredOn: '2026-10-25', place: 'Parcheggio, caduta da fermo (inventato)', styleId: style.id, serial: 'SN-DEMO-000123', batchNumber: 'L-2231', outcome: 'MINOR_HARM', authority: { toldAt: '2026-10-30T12:00:00Z', byId: id(801), reference: 'SBG-DEMO-0042', noticeId: null }, note: 'Comunicato per scrupolo (inventato).' }),
    reportId: id(4),
    companyId: COMPANY,
    number: 'PSR-DEMO-0004',
    reportStatus: 'CLOSED',
    style,
    revisions: 3,
    mustTell: false,
  },
]

export const LOG_TILES = { entries: 3, toTell: 1, told: 1 }

const actions = (over: Partial<Record<ReportAction['action'], ReportAction['held'] | 'ok'>> = {}): ReportAction[] =>
  (['seen', 'assess', 'close', 'edit', 'file', 'photos', 'logAccident', 'eraseReporter', 'openInjury', 'recordInjury', 'eraseInjury'] as const).map((action) => {
    const value = over[action] ?? 'ok'
    return { action, allowed: value === 'ok', held: value === 'ok' ? null : value }
  })

/** A report as quality reads it: an accident with serious harm not told yet, being assessed. */
export const REPORT: Report = {
  ...ROWS[1]!,
  contact: { id: id(611), name: 'Anna Esempio' },
  reporter: null,
  reporterHidden: false,
  colourway: { id: id(721), code: 'NER', name: 'Nero' },
  whatHappened: 'Il rinforzo del ginocchio si è staccato durante una caduta in pista: la protezione è scivolata fuori dalla tasca (dati inventati).',
  wornAsIntended: true,
  seenAt: '2026-11-11T16:00:00Z',
  seenById: id(801),
  registerEntry: { id: id(501), reference: 'REG-DEMO-0007', status: 'OPEN' },
  closed: null,
  injury: { recorded: true, mayOpen: true },
  accidentLog: { revisions: 2, newest: REVISIONS[0]!, state: { told: false, mustTell: true, words: '' } },
  photos: [{ id: id(301), name: 'PSR-DEMO-0002-photo-1.jpg', contentType: 'image/jpeg', sizeBytes: 182_000, availableAt: '2026-11-11T15:10:00Z' }],
  createdAt: '2026-11-11T15:02:00Z',
  createdById: null,
  actions: actions({ seen: 'SEEN', assess: 'ALREADY', file: 'FILED', recordInjury: 'INJURY_RECORDED', eraseReporter: 'NOTHING_TO_ERASE' }),
  people: PEOPLE,
}

/** A new public report nobody has seen (no customer, the batch from the QR, no photos). */
export const NEW_REPORT: Report = {
  ...ROWS[0]!,
  contact: null,
  reporter: { name: 'Lettore Demo', email: 'lettore@example.com', phone: null },
  reporterHidden: false,
  colourway: null,
  whatHappened: 'In una scivolata la cucitura della spalla si è aperta (dati inventati).',
  wornAsIntended: null,
  seenAt: null,
  seenById: null,
  registerEntry: null,
  closed: null,
  injury: { recorded: true, mayOpen: true },
  accidentLog: { revisions: 1, newest: { ...REVISIONS[1]!, occurredOn: '2026-11-08', place: 'Strada provinciale (inventato)' }, state: { told: false, mustTell: false, words: '' } },
  photos: [],
  createdAt: '2026-11-12T07:15:00Z',
  createdById: null,
  actions: actions({ recordInjury: 'INJURY_RECORDED', eraseInjury: 'NO_WORDS' }),
  people: PEOPLE,
}

/** A closed report (the accident log and an erasure still may). */
export const CLOSED_REPORT: Report = {
  ...ROWS[3]!,
  contact: null,
  reporter: null,
  reporterHidden: false,
  colourway: null,
  whatHappened: 'Caduta da fermo nel parcheggio; la zip si è rotta (dati inventati).',
  wornAsIntended: true,
  seenAt: '2026-10-28T09:30:00Z',
  seenById: id(801),
  registerEntry: { id: id(502), reference: 'REG-DEMO-0005', status: 'CLOSED' },
  closed: { at: '2026-11-02T11:00:00Z', byId: id(801), note: 'Cucitura controllata sul lotto: nessun difetto di serie; garanzia applicata (inventato).' },
  injury: { recorded: false, mayOpen: true },
  accidentLog: { revisions: 3, newest: LOG[2]!, state: { told: true, mustTell: false, words: '' } },
  photos: [],
  createdAt: '2026-10-28T09:00:00Z',
  createdById: id(802),
  actions: actions({ seen: 'CLOSED', assess: 'CLOSED', close: 'CLOSED', edit: 'CLOSED', file: 'CLOSED', photos: 'CLOSED', eraseReporter: 'NOTHING_TO_ERASE', openInjury: 'NO_INJURY', eraseInjury: 'NO_INJURY' }),
  people: PEOPLE,
}

/** The same report as read-only reads it: no reporter, nothing to do. */
export function asReadOnly(report: Report): Report {
  return { ...report, reporter: null, reporterHidden: true, injury: { ...report.injury, mayOpen: false }, actions: report.actions.map((action) => ({ ...action, allowed: false, held: 'NO_PERMISSION' })) }
}
