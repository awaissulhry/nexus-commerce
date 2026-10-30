import { renewalWindowOf, stageDay, windowPhase } from '@nexus/factory-domain/compliance/renewals/rules'
import { at, uid } from '../../../quality/_shared/fixtures'
import { failedRead, reading, ready } from '../../../quality/_shared/model'
import type { Certificate } from '../api'
import { byNumber, JACKET, TODAY } from '../fixtures'
import type { Renewals, Review, Stage } from './api'
import { blankRenewalDraft, type RenewalsModel } from './model'

/**
 * Made-up renewals for the design cases of SCR-051 › Renewals (B-W2a-66): the CERT-DEMO-… register of SCR-050, notified
 * body "Demo Test Lab" 0000, the rules "Quality inspector" tells. Nothing here is real business data.
 */

const ROLE = { id: uid('5601', 1), name: 'Quality inspector' }
const RULES = { r180: uid('5602', 1), r90: uid('5602', 2), r30: uid('5602', 3) }

function stage(ruleId: string, daysBefore: number, validTo: string, state: 'waiting' | 'fired' | 'notSet' | 'off' | 'cancelled', alert: Stage['alert'] = null): Stage {
  const fireOn = stageDay(validTo, daysBefore)
  return {
    ruleId,
    name: daysBefore === 30 ? 'Certificate expiring' : `Certificate renewal: ${daysBefore} days before expiry`,
    daysBefore,
    workingDays: false,
    enabled: state !== 'off',
    builtIn: daysBefore === 30,
    severity: daysBefore === 30 ? 'CRITICAL' : 'WARNING',
    recipientRole: ROLE,
    fireOn,
    timer: state === 'notSet' || state === 'off' ? null : { id: uid('5603', daysBefore), status: state === 'fired' ? 'FIRED' : state === 'cancelled' ? 'CANCELLED' : 'PENDING', fireAt: `${fireOn}T05:00:00.000Z`, firedAt: state === 'fired' ? `${fireOn}T05:01:00.000Z` : null, cancelReason: state === 'cancelled' ? 'Renewed by certificate CERT-DEMO-0009: no more expiry alerts for CERT-DEMO-0002.' : null },
    alert,
  }
}

const certificateOf = (certificate: Certificate): Renewals['certificate'] => ({
  id: certificate.id,
  number: certificate.number,
  status: certificate.status,
  standard: certificate.standard,
  ppeClass: certificate.ppeClass,
  companyId: certificate.companyId,
  holderPartyId: certificate.holderPartyId,
  notifiedBodyName: certificate.notifiedBodyName,
  notifiedBodyNumber: certificate.notifiedBodyNumber,
  validFrom: certificate.validFrom,
  validTo: certificate.validTo,
  daysToExpiry: certificate.daysToExpiry,
  version: certificate.version,
})

const NEW_CERT = { id: uid('5503', 9), number: 'CERT-DEMO-0009', standard: 'EN 17092-4:2020', status: 'VALID' as const, validFrom: '2026-11-20', validTo: '2031-11-19' }

function renewalsOf(certificate: Certificate, over: Partial<Renewals> = {}): Renewals {
  const window = renewalWindowOf(certificate.validTo)
  return {
    today: TODAY,
    certificate: certificateOf(certificate),
    window: { ...window, phase: windowPhase(certificate.validTo, TODAY) },
    stages: [stage(RULES.r180, 180, certificate.validTo, 'notSet'), stage(RULES.r90, 90, certificate.validTo, 'notSet'), stage(RULES.r30, 30, certificate.validTo, 'notSet')],
    renewal: null,
    successor: null,
    renews: null,
    candidates: [],
    carriedOver: null,
    nextStep: 'START',
    log: [],
    ...over,
  }
}

const URBAN = byNumber('CERT-DEMO-0002')
const TOURING = byNumber('CERT-DEMO-0001')

const TASK_STEPS = [
  'Check the technical file: changes since the examination, reviews with the notified body’s answer',
  'Send the application for review to Demo Test Lab (0000) by 2026-05-23',
  'Send what the notified body asks for (samples, tests, documents)',
  'Register the new certificate with its PDF and coverage',
  'Link the new certificate to this one on the Renewals tab',
]

/** CERT-DEMO-0002 (ends 2026-11-23): every alert fired, the renewal started and applied for (late), the new one registered. */
export const URBAN_RENEWAL: Renewals = renewalsOf(URBAN, {
  stages: [
    stage(RULES.r180, 180, URBAN.validTo, 'fired', { id: uid('5604', 1), state: 'RESOLVED', raisedAt: at(26, 5), resolvedAt: at(27, 9), occurrence: 1, told: 2 }),
    stage(RULES.r90, 90, URBAN.validTo, 'fired', { id: uid('5604', 2), state: 'OPEN', raisedAt: at(27, 5), resolvedAt: null, occurrence: 2, told: 2 }),
    stage(RULES.r30, 30, URBAN.validTo, 'fired'),
  ],
  renewal: {
    startedAt: at(27, 10),
    startedBy: 'Giulia Demo',
    taskId: uid('5605', 1),
    task: {
      id: uid('5605', 1),
      title: 'Renew certificate CERT-DEMO-0002',
      status: 'OPEN',
      dueDate: '2026-05-23',
      assignee: 'Giulia Demo',
      checklist: TASK_STEPS.map((text, index) => ({ text, done: index < 2, doneAt: index < 2 ? at(28, 11 + index) : null, doneBy: index < 2 ? 'Giulia Demo' : null })),
    },
    appliedOn: '2026-10-28',
    reference: 'DEMO-NB-REQ-0412',
    note: null,
    inWindow: false,
  },
  candidates: [NEW_CERT],
  nextStep: 'LINK',
  log: [
    { at: at(27, 10), action: 'STARTED', by: 'Giulia Demo', detail: '2026-05-23' },
    { at: at(28, 12), action: 'APPLIED', by: 'Giulia Demo', detail: '2026-10-28' },
  ],
})

/** CERT-DEMO-0001 (ends 2029-03-11): the window opens in 2028, the alert timers come later. */
export const TOURING_RENEWAL: Renewals = renewalsOf(TOURING)

/** CERT-DEMO-0002 renewed by CERT-DEMO-0009: the alerts stopped; one style not covered by the new one yet. */
export const URBAN_RENEWED: Renewals = {
  ...URBAN_RENEWAL,
  stages: URBAN_RENEWAL.stages.map((entry) => (entry.daysBefore === 30 ? { ...entry, timer: { ...entry.timer!, status: 'CANCELLED', firedAt: null, cancelReason: 'Renewed by certificate CERT-DEMO-0009: no more expiry alerts for CERT-DEMO-0002.' } } : entry.alert ? { ...entry, alert: { ...entry.alert, state: 'RESOLVED', resolvedAt: at(29, 9) } } : entry)),
  renewal: { ...URBAN_RENEWAL.renewal!, task: { ...URBAN_RENEWAL.renewal!.task!, status: 'DONE', checklist: URBAN_RENEWAL.renewal!.task!.checklist.map((item) => ({ ...item, done: true, doneAt: item.doneAt ?? at(29, 9), doneBy: 'Giulia Demo' })) } },
  successor: NEW_CERT,
  candidates: [],
  carriedOver: [
    { styleId: JACKET.id, code: JACKET.code, name: JACKET.name, covered: true },
    { styleId: uid('5504', 7), code: 'DEMO-JKT-02', name: 'Giacca urban Demo', covered: false },
  ],
  nextStep: 'RENEWED',
  log: [...URBAN_RENEWAL.log, { at: at(29, 9), action: 'RENEWED', by: 'Giulia Demo', detail: 'CERT-DEMO-0009' }],
}

/** An expired certificate: nothing to start; a late successor may still be linked. */
export const EXPIRED_RENEWAL: Renewals = renewalsOf(byNumber('CERT-DEMO-0006'), { nextStep: 'LINK', stages: [] })

const ref = (revision: number) => ({ id: uid('5606', revision), revision, status: revision === 3 ? 'RELEASED' : 'OBSOLETE' })

function review(n: number, over: Partial<Review> = {}): Review {
  return {
    id: uid('5607', n),
    styleId: JACKET.id,
    style: { id: JACKET.id, code: JACKET.code, name: JACKET.name, companyId: JACKET.companyId },
    revision: ref(3),
    comparedRevision: ref(2),
    certificate: { id: URBAN.id, number: URBAN.number, standard: URBAN.standard, status: URBAN.status, notifiedBodyName: URBAN.notifiedBodyName, notifiedBodyNumber: URBAN.notifiedBodyNumber },
    changes: [{ kind: 'LINING', what: 'Lining', before: 'DEMO-LIN-200 Fodera rete grigia', after: 'DEMO-LIN-210 Fodera rete leggera', bomLineId: uid('5608', 1) }],
    status: 'OPEN',
    holdsLabel: true,
    notifiedAt: null,
    answeredOn: null,
    answerReference: null,
    decidedAt: null,
    decidedBy: null,
    decisionNote: null,
    files: [],
    version: 1,
    createdAt: at(26, 15),
    updatedAt: at(26, 15),
    ...over,
  }
}

export const REVIEWS: Review[] = [
  review(1),
  review(2, {
    revision: ref(2),
    comparedRevision: ref(1),
    changes: [
      { kind: 'OUTER_LEATHER', what: 'Outer leather', before: 'DEMO-LEA-100 Vacchetta 1.1–1.3 mm', after: 'DEMO-LEA-110 Vacchetta 1–1.2 mm', bomLineId: uid('5608', 2) },
      { kind: 'THICKNESS', what: 'Leather thickness', before: '1.1–1.3 mm', after: '1–1.2 mm', bomLineId: uid('5608', 2) },
      { kind: 'SEAMS', what: 'Seams (thread)', before: '—', after: 'DEMO-THR-400 Filo legato', bomLineId: uid('5608', 3) },
    ],
    status: 'NOTIFIED',
    notifiedAt: at(20, 10),
    version: 2,
  }),
  review(3, { revision: ref(1), comparedRevision: null, status: 'APPROVED', holdsLabel: false, notifiedAt: at(2, 9), answeredOn: '2026-10-12', answerReference: 'DEMO-ADD-0007', decidedAt: at(12, 15), decidedBy: 'Giulia Demo', decisionNote: 'Addition 7 to the certificate.', files: [{ id: uid('5609', 1), originalName: 'demo-addition-0007.pdf', contentType: 'application/pdf', sizeBytes: 211_004, createdAt: at(12, 14) }], version: 3 }),
]

export function renewalsModel(over: Partial<RenewalsModel> = {}): RenewalsModel {
  return {
    renewals: ready(URBAN_RENEWAL),
    reviews: ready(REVIEWS),
    people: ready([
      { id: uid('5610', 1), name: 'Giulia Demo', me: true },
      { id: uid('5610', 2), name: 'Marco Demo', me: false },
    ]),
    dialog: null,
    draft: blankRenewalDraft(TODAY, 'en'),
    busy: false,
    problem: null,
    lines: [],
    selected: [],
    ...over,
  }
}

export const RENEWAL_STATES = {
  loading: renewalsModel({ renewals: reading(), reviews: reading() }),
  error: renewalsModel({ renewals: failedRead('problem.unavailable'), reviews: failedRead('problem.unavailable') }),
}
