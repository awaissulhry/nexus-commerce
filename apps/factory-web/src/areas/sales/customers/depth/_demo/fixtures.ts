import { CUSTOMERS, at } from '../../../../parties/_shared/fixtures'
import { DEMO_COMPANIES } from '../../../../../shell/design-data'
import type { AccessCopy, CompanyTerms, Erased, Glance, Holds, Privacy, Requirement, Requirements, StyleOption } from '../api'
import { depthCan, type DepthCan } from '../model'

/**
 * Made-up data for the design cases of B-W2b-324 (SCR-032 Riders, SCR-033 the customer in depth): the "Demo" and
 * "Esempio" customers of the shared party fixtures, invented riders, styles, rounds, repairs, holds, rules and contacts.
 * Nothing here is a real company, person or number. Design-only (a fixtures file: only fixtures and tests import it; it exports
 * no `designScreen`, so the design index skips it).
 */

const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const party = (code: string) => CUSTOMERS.find((item) => item.code === code)!
export const MODA = party('MODA-DEMO')
export const MARCHIO = party('MARCHIO-ESEMPIO')
export const PILOTA = party('PILOTA-DEMO')
const COMPANY = { id: DEMO_COMPANIES[0].id, code: DEMO_COMPANIES[0].code, name: DEMO_COMPANIES[0].name }
const OTHER = { id: DEMO_COMPANIES[1].id, code: DEMO_COMPANIES[1].code, name: DEMO_COMPANIES[1].name }
export const COMPANIES = [
  { id: COMPANY.id, name: COMPANY.name },
  { id: OTHER.id, name: OTHER.name },
]
export const TODAY = '2026-10-29'

export const ALL_CAN: DepthCan = depthCan(['parties.manage', 'parties.hold', 'parties.privacy', 'parties.erase', 'money.price', 'product.styles.view', 'files.read'])
/** Sales: no erasure (finance's). */
export const SALES_CAN: DepthCan = { ...ALL_CAN, erase: false }
/** A reader: nothing to change, no price grain. */
export const READ_CAN: DepthCan = depthCan([])

// ---- the glance --------------------------------------------------------------------------------------------------------

const SAMPLES: NonNullable<Glance['samples']> = {
  count: 3,
  rows: [
    { id: uid('a324', 1), number: 'SR-2026-0041', kind: 'FIT', roundNo: 2, stage: 'UNDER_REVIEW', style: { id: uid('b324', 1), code: 'JKT-DEMO-01', name: 'Giacca Demo Pista' }, dueDate: '2026-10-24', daysLate: 5 },
    { id: uid('a324', 2), number: 'SR-2026-0044', kind: 'SALESMAN', roundNo: 1, stage: 'IN_MAKING', style: { id: uid('b324', 2), code: 'GLV-DEMO-03', name: 'Guanto Demo Corto' }, dueDate: '2026-11-06', daysLate: -8 },
  ],
}
const PROFILES: NonNullable<Glance['profiles']> = {
  count: 2,
  rows: [
    { id: uid('c324', 1), riderName: 'Rider Uno Demo', garmentType: 'JACKET', revision: 3, baseSize: '52', takenAt: at(20, 9) },
    { id: uid('c324', 2), riderName: 'Rider Due Esempio', garmentType: 'SUIT', revision: 1, baseSize: '50', takenAt: at(2, 15) },
  ],
}
const RIDERS: NonNullable<Glance['riders']> = {
  count: 3,
  rows: [
    { id: PILOTA.id, code: PILOTA.code, name: PILOTA.legalName, status: 'ACTIVE', profiles: 2 },
    { id: uid('d324', 2), code: 'PILOTA-ESEMPIO', name: 'Marta Esempio', status: 'ACTIVE', profiles: 1 },
    { id: uid('d324', 3), code: 'PILOTA-PROVA', name: 'Paolo Prova', status: 'PROSPECT', profiles: 0 },
  ],
}
const REPAIRS: NonNullable<Glance['repairs']> = { count: 1, rows: [{ id: uid('e324', 1), number: 'RP-2026-0007', kind: 'REPAIR', stage: 'IN_REPAIR', createdAt: at(22, 10) }] }

export function glanceOf(code: 'MODA-DEMO' | 'MARCHIO-ESEMPIO' | 'PILOTA-DEMO', over: Partial<Glance> = {}): Glance {
  const item = party(code)
  return {
    party: { id: item.id, code: item.code, name: item.tradeName ?? item.legalName, kind: item.kind, status: item.status },
    company: COMPANY,
    hold: { onHold: false, holds: [] },
    team: code === 'PILOTA-DEMO' ? { id: MARCHIO.id, code: MARCHIO.code, name: MARCHIO.tradeName ?? MARCHIO.legalName, status: 'ACTIVE' } : null,
    requirements: {
      count: code === 'PILOTA-DEMO' ? 0 : 3,
      rows:
        code === 'PILOTA-DEMO'
          ? []
          : [
              { id: uid('f324', 1), kind: 'PACKING', words: 'Two hangtags per jacket, the size label inside the collar (made-up).', appliesAt: ['ORDER', 'PACKING'], everyStyle: true, everyCompany: false },
              { id: uid('f324', 2), kind: 'DOCUMENT', words: 'The routing guide travels with every pallet (made-up).', appliesAt: ['SHIPMENT'], everyStyle: true, everyCompany: true },
              { id: uid('f324', 3), kind: 'LABEL', words: 'Care label in Italian and German for the track jacket (made-up).', appliesAt: ['QUOTE', 'ORDER'], everyStyle: false, everyCompany: false },
            ],
    },
    promises: code === 'PILOTA-DEMO' ? { open: 0, late: 0, noPromise: 0, next: null } : { open: 4, late: 1, noPromise: 0, next: '2026-11-14' },
    credit:
      code === 'PILOTA-DEMO'
        ? { state: 'NONE', currency: null, limit: null, used: null, available: null, overLimitBy: null, overdue: null, usedPct: null, onHold: false }
        : { state: 'WITHIN', currency: 'EUR', limit: 5_000_000, used: 3_120_000, available: 1_880_000, overLimitBy: 0, overdue: 0, usedPct: 62, onHold: false },
    samples: code === 'PILOTA-DEMO' ? { count: 0, rows: [] } : SAMPLES,
    profiles: code === 'MODA-DEMO' ? { count: 0, rows: [] } : code === 'PILOTA-DEMO' ? { count: 1, rows: [PROFILES.rows[0]!] } : PROFILES,
    riders: code === 'MARCHIO-ESEMPIO' ? RIDERS : code === 'MODA-DEMO' ? { count: 0, rows: [] } : null,
    repairs: code === 'PILOTA-DEMO' ? { count: 0, rows: [] } : REPAIRS,
    withheld: [],
    readAt: at(29, 9, 40),
    ...over,
  }
}

export const HELD_GLANCE: Partial<Glance> = {
  hold: {
    onHold: true,
    holds: [
      { id: uid('g324', 1), reason: 'CREDIT', words: 'Over the credit limit: two invoices overdue (made-up).', everyCompany: false, placedAt: at(27, 7), placedBy: null },
      { id: uid('g324', 2), reason: 'QUALITY_DISPUTE', words: 'Waiting for the answer on the September claim (made-up).', everyCompany: true, placedAt: at(28, 14), placedBy: 'Alex Demo' },
    ],
  },
  credit: { state: 'OVER', currency: 'EUR', limit: 5_000_000, used: 5_310_000, available: -310_000, overLimitBy: 310_000, overdue: 420_000, usedPct: 106, onHold: true },
}

/** The same glance as a role without the price grain receives it (the amounts dropped by the API). */
export function withoutPrices(glance: Glance): Glance {
  const credit = glance.credit
  return { ...glance, credit: credit ? { state: credit.state, currency: credit.currency, onHold: credit.onHold } : null }
}

export const WITHHELD: Partial<Glance> = { promises: null, credit: null, samples: null, profiles: null, repairs: null, withheld: ['promises', 'credit', 'samples', 'profiles', 'repairs'] }

// ---- holds, terms ------------------------------------------------------------------------------------------------------

export const HOLDS: Holds = {
  onHold: true,
  holds: [
    { id: uid('g324', 2), companyId: null, company: null, reason: 'QUALITY_DISPUTE', words: 'Waiting for the answer on the September claim (made-up).', inForce: true, placedAt: at(28, 14), placedBy: 'Alex Demo', releasedAt: null, releasedBy: null, releaseWords: null, version: 1 },
    { id: uid('g324', 3), companyId: COMPANY.id, company: { code: COMPANY.code, name: COMPANY.name }, reason: 'CREDIT', words: 'Two invoices overdue in August (made-up).', inForce: false, placedAt: at(2, 8), placedBy: null, releasedAt: at(9, 11), releasedBy: 'Bea Esempio', releaseWords: 'Paid in full on 9 Oct (made-up).', version: 2 },
  ],
  ordersWaiting: [{ quoteId: uid('h324', 1), number: 'Q-2026-0118', revision: 2, quoteVersionId: uid('h324', 2), companyId: COMPANY.id, customerRef: null }],
  mayPlace: true,
}
export const NO_HOLDS: Holds = { onHold: false, holds: [], ordersWaiting: [], mayPlace: true }
export const TWO_HOLDS: Holds = {
  ...HOLDS,
  holds: [HOLDS.holds[0]!, { ...HOLDS.holds[1]!, id: uid('g324', 4), reason: 'LEGAL', words: 'Contract wording under review (made-up).', inForce: true, releasedAt: null, releasedBy: null, releaseWords: null, version: 1 }],
}

export const TERMS: CompanyTerms = {
  tenantWide: true,
  companies: [
    { company: COMPANY, terms: { id: uid('i324', 1), companyId: COMPANY.id, poNumberRequired: true, setBy: 'Alex Demo', setAt: at(15, 10), version: 2 }, inForce: { poNumberRequired: true }, mayChange: true },
    { company: OTHER, terms: null, inForce: { poNumberRequired: false }, mayChange: true },
  ],
}

// ---- requirements ------------------------------------------------------------------------------------------------------

const requirement = (n: number, over: Partial<Requirement>): Requirement => ({
  id: uid('f324', n),
  companyId: COMPANY.id,
  companyCode: COMPANY.code,
  kind: 'PACKING',
  words: '',
  appliesAt: ['ORDER'],
  styles: [],
  everyStyle: true,
  file: null,
  supersedesId: null,
  active: true,
  createdAt: at(10, 9),
  createdBy: 'Alex Demo',
  endedAt: null,
  endedBy: null,
  endReason: null,
  version: 1,
  ...over,
})
export const REQUIREMENTS: Requirements = {
  inForce: [
    requirement(1, { kind: 'PACKING', words: 'Two hangtags per jacket, the size label inside the collar (made-up).', appliesAt: ['ORDER', 'PACKING'] }),
    requirement(2, { kind: 'DOCUMENT', companyId: null, companyCode: null, words: 'The routing guide travels with every pallet (made-up).', appliesAt: ['SHIPMENT'], file: { id: uid('j324', 1), fileName: 'Routing guide demo.pdf' } }),
    requirement(3, { kind: 'LABEL', words: 'Care label in Italian and German for the track jacket (made-up).', appliesAt: ['QUOTE', 'ORDER'], everyStyle: false, styles: [{ id: uid('b324', 1), code: 'JKT-DEMO-01', name: 'Giacca Demo Pista' }], supersedesId: uid('f324', 4), createdAt: at(20, 9) }),
  ],
  ended: [requirement(4, { kind: 'LABEL', words: 'Care label in Italian only (made-up).', appliesAt: ['QUOTE', 'ORDER'], active: false, endedAt: at(20, 9), endedBy: 'Alex Demo', endReason: 'German added for the new market (made-up).', version: 2 })],
}
export const STYLES: readonly StyleOption[] = [
  { id: uid('b324', 1), code: 'JKT-DEMO-01', name: 'Giacca Demo Pista' },
  { id: uid('b324', 2), code: 'GLV-DEMO-03', name: 'Guanto Demo Corto' },
  { id: uid('b324', 3), code: 'PNT-DEMO-02', name: 'Pantalone Demo Strada' },
]
export const FILES = [{ id: uid('j324', 1), name: 'Routing guide demo.pdf' }]

// ---- contacts' personal data -------------------------------------------------------------------------------------------

const contactOf = (n: number) => MODA.contacts[n]!
export const PRIVACY: Privacy = {
  notRecorded: 1,
  contacts: [
    { id: contactOf(0).id, name: contactOf(0).name, erased: false, status: 'ACTIVE', lawfulBasis: 'CONTRACT', consentAt: null, consentSource: null, objectedAt: null, erasedAt: null, erasedBy: null, version: 3 },
    { id: contactOf(1).id, name: contactOf(1).name, erased: false, status: 'ACTIVE', lawfulBasis: null, consentAt: null, consentSource: null, objectedAt: null, erasedAt: null, erasedBy: null, version: 1 },
    { id: uid('k324', 1), name: 'Chiara Prova', erased: false, status: 'ACTIVE', lawfulBasis: 'CONSENT', consentAt: at(3, 12), consentSource: 'Newsletter form at the fair (made-up)', objectedAt: at(25, 9), erasedAt: null, erasedBy: null, version: 4 },
    { id: uid('k324', 2), name: '', erased: true, status: 'ARCHIVED', lawfulBasis: 'CONTRACT', consentAt: null, consentSource: null, objectedAt: null, erasedAt: at(18, 16), erasedBy: 'Bea Esempio', version: 6 },
  ],
}
export const COPY: AccessCopy & { raw: unknown } = {
  madeAt: at(29, 9, 45),
  copy: {
    person: { name: contactOf(0).name, email: contactOf(0).email, phone: null, roles: ['ORDERS'], language: null, status: 'ACTIVE' },
    processing: { organisation: { code: MODA.code, legalName: MODA.legalName }, lawfulBasis: 'CONTRACT', consentAt: null, consentSource: null, objectedAt: null },
    records: { quotes: [{ id: uid('l324', 1), number: 'Q-2026-0101', status: 'SENT', at: at(1, 9) }], inquiries: [], returns: [], complaints: [] },
    mailsReceived: [{ id: uid('l324', 2) }, { id: uid('l324', 3) }],
    mailsSent: [{ id: uid('l324', 4) }],
    messages: [],
    links: [{ id: uid('l324', 5) }],
    measurementProfiles: [],
    portalUsers: [],
    changes: [{ at: at(1, 9) }],
    truncated: false,
  },
  raw: { madeAt: at(29, 9, 45), note: 'made-up' },
}
export const KEPT: Erased['kept'] = [
  { kind: 'documents', count: 2 },
  { kind: 'auditRows', count: 3 },
]

