import { createElement, type ReactNode } from 'react'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { permissionCheck } from '../../../../lib/session/session'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER, OWNER_PERMISSIONS } from '../../../../shell/design-data'
import { officeNavFor } from '../../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../../shell/office/view/OfficeShellView'
import type { Appointment, AppointmentRow, ContactOption, FittingResult, FittingsTab, MtmCheck, PartyOption, Person, ProfileRecord, ProfileRow, RepeatFacts, Revision, Sent, StyleDetail, StyleOption, TemplateOption, Tiles, Worksheet } from '../api'
import { formPoints, mtmCan, type MtmCan, type ProofLine } from '../model'

/**
 * Design-only made-up data of Sales › Made-to-measure (SCR-036, the rider profile SCR-036-record, the worksheet SCR-431): "Demo"
 * customers and riders, people at example.com, made-up measures and dates. Nothing here is a real company, person, body or order.
 */

export const PREFIX = '/w/DEMO'
export const COMPANY_ID = DEMO_COMPANIES[0].id
export const ME = DEMO_USER.id
export const ME_PERSON: Person = { id: ME, name: DEMO_USER.displayName }
export const NOW = '2026-11-13T09:42:00.000Z'
export const TODAY = '2026-11-13'

/** A made-up uuid in a family. */
export const uid = (family: string, n: number): string => `0190f0e2-${family.padStart(4, '0').slice(-4)}-7000-8000-${String(n).padStart(12, '0')}`
const at = (month: number, day: number, hour = 9, minute = 0, year = 2026): string => new Date(Date.UTC(year, month - 1, day, hour, minute)).toISOString()

const template = (key: string): string[] => {
  const role = templateOf(key)
  return [...(role?.permissions ?? []), ...(role?.grains ?? []).map((grain) => `money.${grain}`), 'home.view']
}

/** The role cases: the owner (everything), sales (records, links, fittings, quotes), the production manager (reviews), a reader and the warehouse (no page). */
export const ROLE_PERMISSIONS = {
  owner: [...OWNER_PERMISSIONS, ...template('sales'), ...template('production_manager'), 'sales.measurements.view', 'sales.measurements.manage', 'sales.mtm.record', 'sales.mtm.review', 'sales.fittings.manage', 'product.styles.view', 'product.styles.manage', 'product.mtm.switch', 'parties.view', 'tasks.manage', 'quotes.manage', 'quotes.view', 'orders.view'],
  sales: template('sales'),
  production: template('production_manager'),
  reader: template('read_only'),
  warehouse: template('warehouse'),
} as const
export type RoleCase = keyof typeof ROLE_PERMISSIONS

export const canFor = (role: RoleCase): MtmCan => mtmCan(ROLE_PERMISSIONS[role])

/** The Office shell around a page (the role's navigation, this page's place). */
export function inShell(path: string, page: ReactNode, role: RoleCase = 'owner'): ReactNode {
  const shell: OfficeShellViewModel = {
    nav: officeNavFor(permissionCheck([...ROLE_PERMISSIONS[role]])),
    path,
    switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: [], site: null, path },
    user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
    tenantTag: DEMO_TAG,
    banners: [],
  }
  return createElement(OfficeShellView, { model: shell }, page)
}

// ---- templates, styles, customers, people ----------------------------------------------------------------------------

export const TEMPLATE_ID = uid('6201', 1)
export const TEMPLATES: TemplateOption[] = [
  { id: TEMPLATE_ID, code: 'JACKET', name: 'Jacket', nameI18n: { it: 'Giacca', en: 'Jacket' }, productType: 'JACKET', companyId: null, status: 'ACTIVE', rulesOn: false, points: 8 },
  { id: uid('6201', 2), code: 'SUIT', name: 'Race suit', nameI18n: { it: 'Tuta da gara', en: 'Race suit' }, productType: 'SUIT', companyId: null, status: 'ACTIVE', rulesOn: false, points: 23 },
  { id: uid('6201', 3), code: 'TROUSERS', name: 'Trousers', nameI18n: { it: 'Pantaloni', en: 'Trousers' }, productType: 'TROUSERS', companyId: null, status: 'ACTIVE', rulesOn: false, points: 9 },
]
export const TEMPLATES_ONE_ON: TemplateOption[] = TEMPLATES.map((entry) => (entry.code === 'JACKET' ? { ...entry, rulesOn: true } : entry))

export const POINTS = [
  { code: 'neck', name: 'Neck', uom: 'CM', required: false, minValue: '30', maxValue: '50', howTo: 'Around the base of the neck, one finger under the tape.', status: 'ACTIVE' },
  { code: 'chest', name: 'Chest', uom: 'CM', required: true, minValue: '70', maxValue: '130', howTo: 'Around the fullest part of the chest, arms relaxed.', status: 'ACTIVE' },
  { code: 'waist', name: 'Waist', uom: 'CM', required: true, minValue: '60', maxValue: '120', howTo: 'At the navel, breathing out.', status: 'ACTIVE' },
  { code: 'hips', name: 'Hips', uom: 'CM', required: false, minValue: '70', maxValue: '135', howTo: null, status: 'ACTIVE' },
  { code: 'back_length', name: 'Back length', uom: 'CM', required: true, minValue: '35', maxValue: '60', howTo: 'From the seventh vertebra to the waist.', status: 'ACTIVE' },
  { code: 'sleeve', name: 'Sleeve', uom: 'CM', required: true, minValue: '50', maxValue: '75', howTo: 'From the shoulder point to the wrist, arm bent as on the bike.', status: 'ACTIVE' },
  { code: 'arm_bicep', name: 'Biceps', uom: 'CM', required: false, minValue: '22', maxValue: '45', howTo: null, status: 'ACTIVE' },
  { code: 'riding_reach', name: 'Reach on the bike', uom: 'MM', required: false, minValue: '450', maxValue: '750', howTo: 'In riding position, shoulder to wrist.', status: 'ACTIVE' },
] as const satisfies NonNullable<ProfileRecord['template']>['points']

export const FORM_POINTS = formPoints(POINTS)

export const STYLES: StyleOption[] = [
  { id: uid('6301', 1), code: 'DEMO-JKT-01', name: 'Demo touring jacket', mtmAllowed: true, sizes: ['48', '50', '52', '54', '56'], baseSize: '52' },
  { id: uid('6301', 2), code: 'DEMO-JKT-02', name: 'Demo race jacket', mtmAllowed: true, sizes: ['48', '50', '52', '54'], baseSize: '50' },
]
export const STYLE: StyleDetail = {
  ...STYLES[0]!,
  measurementTemplate: { id: TEMPLATE_ID, code: 'JACKET', name: 'Jacket' },
  colourways: [
    { id: uid('6302', 1), code: 'BLK', name: 'Black', status: 'ACTIVE' },
    { id: uid('6302', 2), code: 'RED', name: 'Racing red', status: 'ACTIVE' },
  ],
}

export const CUSTOMERS: PartyOption[] = [
  { id: uid('6401', 1), code: 'DEMO-TEAM', legalName: 'Demo Racing Team' },
  { id: uid('6401', 2), code: 'DEMO-P01', legalName: 'Demo Rider Uno' },
  { id: uid('6401', 3), code: 'DEMO-SHOP', legalName: 'Demo Moto Shop' },
]
export const CONTACTS: ContactOption[] = [
  { id: uid('6402', 1), name: 'Demo Rider Due', email: 'rider.due@example.com', status: 'ACTIVE', roles: ['RIDER'] },
  { id: uid('6402', 2), name: 'Demo Team Manager', email: 'team@example.com', status: 'ACTIVE', roles: ['ORDERS'] },
]
export const PEOPLE: Person[] = [ME_PERSON, { id: uid('3333', 7), name: 'Demo Pattern Maker' }, { id: uid('3333', 8), name: 'Demo Fitter' }]

// ---- the list ------------------------------------------------------------------------------------------------------------

const row = (n: number, over: Partial<ProfileRow>): ProfileRow => ({
  id: uid('6501', n),
  partyId: CUSTOMERS[0]!.id,
  customer: { code: CUSTOMERS[0]!.code, name: CUSTOMERS[0]!.legalName },
  contactId: CONTACTS[0]!.id,
  riderName: `Demo Rider ${n}`,
  garmentType: 'JACKET',
  revision: 1,
  takenAt: at(11, 10 - (n % 9)),
  takenBy: 'Demo Fitter',
  measuredPlace: 'Showroom',
  baseSize: '52',
  review: { status: 'WAITING', at: null },
  byLink: false,
  privacyNoticeAt: at(11, 10 - (n % 9), 8),
  old: false,
  openUnits: 0,
  nextFittingAt: null,
  // B-W2b-371: the certified range is not known without an open unit.
  range: { inside: null, points: [] },
  ...over,
})

export const ROWS: ProfileRow[] = [
  row(1, { riderName: 'Demo Rider Due', revision: 3, review: { status: 'WAITING', at: null }, openUnits: 1, nextFittingAt: at(11, 18, 10) }),
  row(2, { riderName: 'Demo Rider Tre', customer: { code: 'DEMO-SHOP', name: 'Demo Moto Shop' }, partyId: CUSTOMERS[2]!.id, byLink: true, takenBy: 'Demo Rider Tre (by link)', measuredPlace: null, review: { status: 'WAITING', at: null } }),
  row(3, { riderName: 'Demo Rider Quattro', garmentType: 'SUIT', revision: 2, review: { status: 'NEED_MORE', at: at(11, 8, 15) }, baseSize: '50' }),
  row(4, { riderName: 'Demo Rider Uno', customer: { code: 'DEMO-P01', name: 'Demo Rider Uno' }, partyId: CUSTOMERS[1]!.id, contactId: null, review: { status: 'CONFIRMED', at: at(10, 2, 11) }, takenAt: at(9, 30), openUnits: 2 }),
  row(5, { riderName: 'Demo Rider Cinque', garmentType: 'TROUSERS', review: { status: 'CONFIRMED', at: at(1, 20, 11, 0, 2025) }, takenAt: at(1, 12, 9, 0, 2025), privacyNoticeAt: at(1, 12, 8, 0, 2025), old: true, baseSize: '54' }),
  row(6, { riderName: 'Demo Rider Sei', revision: 2, review: { status: 'CONFIRMED', at: at(11, 3, 12) }, nextFittingAt: at(11, 20, 15) }),
]
export const MANY_ROWS: ProfileRow[] = Array.from({ length: 48 }, (_, index) => row(index + 10, { riderName: `Demo Rider ${index + 10}`, review: { status: (['WAITING', 'CONFIRMED', 'NEED_MORE'] as const)[index % 3]!, at: index % 3 === 0 ? null : at(11, 1 + (index % 10)) }, garmentType: ['JACKET', 'SUIT', 'TROUSERS'][index % 3]! }))
export const TILES_DATA: Tiles = { waitingReview: 2, needMore: 1, older: 1, fittingsThisWeek: 3, outsideRange: null }

// ---- the record ------------------------------------------------------------------------------------------------------------

export const PROFILE_ID = uid('6501', 1)
const measures = (chest: string, waist: string, sleeve: string, extra: Record<string, string> = {}): Revision['measurements'] => ({
  neck: { value: '41', unit: 'cm' },
  chest: { value: chest, unit: 'cm' },
  waist: { value: waist, unit: 'cm' },
  hips: { value: '101', unit: 'cm' },
  back_length: { value: '47', unit: 'cm' },
  sleeve: { value: sleeve, unit: 'cm' },
  arm_bicep: { value: '33', unit: 'cm' },
  riding_reach: { value: '620', unit: 'mm' },
  height: { value: '181', unit: 'cm' },
  weight: { value: '78', unit: 'kg' },
  ...Object.fromEntries(Object.entries(extra).map(([code, value]) => [code, { value, unit: 'cm' }])),
})

const revision = (n: number, over: Partial<Revision>): Revision => ({
  id: uid('6501', n === 3 ? 1 : 100 + n),
  revision: n,
  supersedesId: n > 1 ? uid('6501', 100 + n - 1) : null,
  measurements: measures('102', '88', '64'),
  baseSize: '52',
  fitNotes: 'Likes a snug fit on the arms; left shoulder slightly lower.',
  internalNote: 'Customer of the team since 2024.',
  takenAt: at(11, 12, 10),
  takenBy: 'Demo Fitter',
  measuredBy: { id: PEOPLE[2]!.id, name: 'Demo Fitter' },
  measuredPlace: 'Showroom',
  privacyNoticeRef: 'Privacy notice for riders v3',
  privacyNoticeAt: at(11, 12, 9, 50),
  byLink: false,
  submittedAt: null,
  photos: 0,
  review: { status: 'WAITING', by: null, at: null, note: null },
  old: false,
  createdAt: at(11, 12, 10, 30),
  ...over,
})

export const REV3 = revision(3, { measurements: measures('104', '89', '64.5'), takenAt: at(11, 12, 10), createdAt: at(11, 12, 10, 30) })
export const REV2 = revision(2, {
  measurements: measures('101', '88', '63'),
  takenAt: at(10, 28, 16),
  takenBy: 'Demo Rider Due (by link)',
  measuredBy: null,
  measuredPlace: null,
  byLink: true,
  submittedAt: at(10, 28, 16, 20),
  photos: 3,
  review: { status: 'NEED_MORE', by: { id: PEOPLE[1]!.id, name: 'Demo Pattern Maker' }, at: at(10, 29, 9), note: 'The sleeve looks short for the reach: please measure the sleeve again with the arm bent.' },
  createdAt: at(10, 28, 16, 20),
})
export const REV1 = revision(1, { measurements: measures('100', '87', '63'), baseSize: '52', takenAt: at(3, 2, 11), review: { status: 'CONFIRMED', by: { id: PEOPLE[1]!.id, name: 'Demo Pattern Maker' }, at: at(3, 3, 9), note: null }, createdAt: at(3, 2, 11, 30) })

const units: ProfileRecord['units'] = [
  { kind: 'ORDER', lineId: uid('6601', 1), documentId: uid('6602', 1), number: 'SO-DEMO-0003', status: 'PENDING_APPROVAL', profileId: REV3.id, revision: 3, style: { id: STYLES[0]!.id, code: 'DEMO-JKT-01' }, colourway: { id: uid('6302', 1), code: 'BLK' }, baseSize: '52', at: at(11, 12, 12) },
  { kind: 'QUOTE', lineId: uid('6601', 2), documentId: uid('6603', 1), number: 'QT-DEMO-0011', status: 'SENT', profileId: REV2.id, revision: 2, style: { id: STYLES[1]!.id, code: 'DEMO-JKT-02' }, colourway: { id: uid('6302', 2), code: 'RED' }, baseSize: '52', at: at(10, 29, 15) },
]

export const WORKSHEETS: Worksheet[] = [
  { id: uid('6701', 2), profileId: REV3.id, revision: 3, version: 2, companyId: COMPANY_ID, language: 'it', number: 'JACKET r3 v2', fileId: uid('6702', 2), createdAt: at(11, 12, 14), createdBy: 'Alex Demo' },
  { id: uid('6701', 1), profileId: REV1.id, revision: 1, version: 1, companyId: COMPANY_ID, language: 'it', number: 'JACKET r1 v1', fileId: uid('6702', 1), createdAt: at(3, 3, 10), createdBy: 'Demo Fitter' },
]

export const RECORD: ProfileRecord = {
  id: PROFILE_ID,
  partyId: CUSTOMERS[0]!.id,
  customer: { code: CUSTOMERS[0]!.code, name: CUSTOMERS[0]!.legalName },
  contactId: CONTACTS[0]!.id,
  riderName: 'Demo Rider Due',
  garmentType: 'JACKET',
  latestId: REV3.id,
  revisions: [REV3, REV2, REV1],
  template: { id: TEMPLATE_ID, code: 'JACKET', name: 'Jacket', rulesOn: true, points: [...POINTS] },
  review: { may: { confirm: true, askMore: true }, why: null, checks: { on: true, warnings: [], blocks: [] }, outside: [], mailTo: true },
  units,
  worksheets: WORKSHEETS,
  nextFittingAt: at(11, 18, 10),
  may: { record: true, worksheet: true },
}
/** The same rider with made-to-measure off for JACKET (as built: GATE-MTM). */
export const RECORD_OFF: ProfileRecord = { ...RECORD, template: { ...RECORD.template!, rulesOn: false } }
/** The newest revision measured by the person looking at it (they may ask for more, not confirm). */
export const RECORD_OWN: ProfileRecord = { ...RECORD, revisions: [{ ...REV3, measuredBy: { id: ME, name: 'Alex Demo' }, takenBy: 'Alex Demo' }, REV2, REV1], review: { ...RECORD.review, may: { confirm: false, askMore: true } } }
export const RECORD_CONFIRMED: ProfileRecord = { ...RECORD, revisions: [{ ...REV3, review: { status: 'CONFIRMED', by: { id: PEOPLE[1]!.id, name: 'Demo Pattern Maker' }, at: at(11, 12, 16), note: 'Confirmed: sleeve +1.5 on the pattern.' } }, REV2, REV1], review: { ...RECORD.review, may: { confirm: false, askMore: false } } }
/** A value outside its plausible range kept because the measurer checked it. */
export const RECORD_OUTSIDE: ProfileRecord = { ...RECORD, revisions: [{ ...REV3, measurements: { ...REV3.measurements, chest: { value: '134', unit: 'cm' } } }, REV2, REV1], review: { ...RECORD.review, outside: ['chest'] } }
export const RECORD_NEW: ProfileRecord = { ...RECORD, revisions: [{ ...REV3, revision: 1, supersedesId: null }], units: [], worksheets: [], nextFittingAt: null }
export const RECORD_VIEW_ONLY: ProfileRecord = { ...RECORD, may: { record: false, worksheet: false }, review: { ...RECORD.review, may: { confirm: false, askMore: false } } }

// ---- the check (B-W2b-248) -------------------------------------------------------------------------------------------------

const baseCheck: MtmCheck = {
  template: { id: TEMPLATE_ID, code: 'JACKET', name: 'Jacket', rulesOn: true },
  style: { id: STYLES[0]!.id, code: 'DEMO-JKT-01', mtmAllowed: true, revision: { id: uid('6303', 1), revision: 4, status: 'RELEASED' } },
  profile: { id: REV3.id, revision: 3, garmentType: 'JACKET' },
  verdict: 'OK',
  rulesOn: true,
  rules: [
    { code: 'WAIST_LE_CHEST', kind: 'ORDER', severity: 'BLOCK', outcome: 'PASSED', pointCode: 'waist', otherPointCode: 'chest', value: '89', otherValue: '104', ratio: null, words: { it: 'La vita non supera il torace', en: 'The waist is not over the chest' }, detail: '' },
    { code: 'SLEEVE_TO_BACK', kind: 'RATIO', severity: 'WARN', outcome: 'PASSED', pointCode: 'sleeve', otherPointCode: 'back_length', value: '64.5', otherValue: '47', ratio: '1.37', words: { it: 'Manica e schiena tornano', en: 'Sleeve and back agree' }, detail: '' },
  ],
  baseSize: { size: '52', how: 'INSIDE', tie: false, points: [{ code: 'chest', value: '104', range: { min: '102', max: '106' }, distance: '0' }], detail: '', used: '52', typed: null },
  alterations: [
    { code: 'chest', uom: 'CM', outcome: 'WITHIN', value: '104', base: '104', difference: '0', alterationMinus: '4', alterationPlus: '6', detail: '' },
    { code: 'sleeve', uom: 'CM', outcome: 'WITHIN', value: '64.5', base: '64', difference: '+0.5', alterationMinus: '2', alterationPlus: '3', detail: '' },
  ],
  consumption: null,
  consumptionHidden: true,
  certificate: { allowed: true, outcome: 'ALLOWED', certificateNumber: 'DEMO-CE-2026-014', message: null, reasons: [] },
  insideCertifiedRange: true,
  blocks: [],
  warnings: [],
  notes: [],
}
export const CHECK_INSIDE = baseCheck
export const CHECK_OUTSIDE: MtmCheck = {
  ...baseCheck,
  verdict: 'BLOCK',
  rules: [{ ...baseCheck.rules[0]!, outcome: 'BROKEN', value: '126', otherValue: '104' }, baseCheck.rules[1]!],
  baseSize: { ...baseCheck.baseSize, size: '56', how: 'NEAREST' },
  alterations: [{ ...baseCheck.alterations[0]!, outcome: 'BEYOND', value: '134', difference: '+12', base: '122' }, baseCheck.alterations[1]!],
  certificate: { allowed: false, outcome: 'REFUSED', certificateNumber: 'DEMO-CE-2026-014', message: null, reasons: [{ code: 'outside_range', message: '', point: 'chest' }] },
  insideCertifiedRange: false,
  blocks: [{ kind: 'RULE', ref: 'WAIST_LE_CHEST', message: '', words: null }, { kind: 'ALTERATION', ref: 'chest', message: '', words: null }],
}
export const CHECK_OFF: MtmCheck = { ...baseCheck, template: { ...baseCheck.template, rulesOn: false }, rulesOn: false, rules: [], alterations: [], certificate: null, insideCertifiedRange: null, verdict: 'OK' }
export const CHECK_FLAGS: MtmCheck = { ...CHECK_OUTSIDE, rules: [{ ...baseCheck.rules[0]!, outcome: 'BROKEN' }, { ...baseCheck.rules[1]!, outcome: 'BROKEN', ratio: '1.71' }] }

// ---- fittings (B-W2b-360) ----------------------------------------------------------------------------------------------------

const appointmentRow = (n: number, over: Partial<AppointmentRow>): AppointmentRow => ({
  id: uid('6801', n),
  companyId: COMPANY_ID,
  partyId: RECORD.partyId,
  customer: RECORD.customer,
  kind: 'FITTING',
  status: 'BOOKED',
  rider: { contactId: RECORD.contactId, name: RECORD.riderName },
  profile: { id: REV3.id, revision: 3, garmentType: 'JACKET' },
  garmentType: 'JACKET',
  startsAt: at(11, 18, 10),
  endsAt: at(11, 18, 11),
  place: 'Showroom',
  with: { userId: PEOPLE[2]!.id, name: 'Demo Fitter' },
  inviteSentAt: at(11, 12, 15),
  reminderSentAt: null,
  results: 0,
  version: 1,
  ...over,
})

export const APPOINTMENTS: AppointmentRow[] = [
  appointmentRow(1, {}),
  appointmentRow(2, { status: 'DONE', startsAt: at(11, 4, 15), endsAt: at(11, 4, 16), place: 'Mugello paddock', profile: { id: REV2.id, revision: 2, garmentType: 'JACKET' }, results: 1, version: 3 }),
  appointmentRow(3, { kind: 'SHOWROOM', status: 'CANCELLED', startsAt: at(10, 20, 11), endsAt: at(10, 20, 12), profile: null, inviteSentAt: null, version: 2 }),
]
export const APPOINTMENT: Appointment = {
  ...APPOINTMENTS[0]!,
  closedAt: null,
  closedBy: null,
  cancelReason: null,
  notes: 'Bring the first-fit shell of the jacket.',
  mailTo: true,
  mails: [{ id: uid('6802', 1), mail: 'INVITE', status: 'SENT', queuedAt: at(11, 12, 15), sentAt: at(11, 12, 15, 1) }],
  resultList: [],
  createdAt: at(11, 12, 15),
  createdBy: ME_PERSON,
  may: { move: true, close: false, cancel: true, invite: true, ledTo: false, result: false, notes: true },
  why: null,
  // B-W2b-F38: the company's fitting reminder off (the Owner's default): the panel says no automatic reminder goes.
  reminderEnabled: false,
}
export const APPOINTMENT_DONE: Appointment = { ...APPOINTMENT, ...APPOINTMENTS[1]!, closedAt: at(11, 4, 16), closedBy: { id: PEOPLE[2]!.id, name: 'Demo Fitter' }, notes: null, mails: [], resultList: [{ id: uid('6901', 1), verdict: 'ALTER', fittedAt: at(11, 4, 15, 40), salesOrderLineId: uid('6601', 1) }], may: { move: false, close: false, cancel: false, invite: false, ledTo: false, result: true, notes: true } }

export const RESULT_ALTER: FittingResult = {
  id: uid('6901', 1),
  companyId: COMPANY_ID,
  partyId: RECORD.partyId,
  appointment: { id: APPOINTMENTS[1]!.id, startsAt: APPOINTMENTS[1]!.startsAt, place: 'Mugello paddock', status: 'DONE' },
  orderLine: { id: uid('6601', 1), orderId: uid('6602', 1), orderNumber: 'SO-DEMO-0003', seq: 10, style: 'DEMO-JKT-01', colourway: 'BLK', baseSize: '52' },
  profile: { id: REV2.id, revision: 2, riderName: RECORD.riderName, garmentType: 'JACKET' },
  fittedAt: at(11, 4, 15, 40),
  verdict: 'ALTER',
  pointChanges: [
    { code: 'chest', name: 'Chest', change: '+2.0', unit: 'cm', note: 'Tight when tucked on the tank' },
    { code: 'sleeve', name: 'Sleeve', change: '+1.5', unit: 'cm', note: null },
  ],
  notes: 'Shoulder hump sits well; arms short in riding position.',
  alterationDays: 5,
  alteration: { id: uid('7001', 2), number: 'REP-DEMO-0002', stage: 'AWAITING_GOODS' },
  newProfile: null,
  promise: { current: '2026-12-09', byAlteration: '2026-12-09' },
  next: null,
  version: 2,
  createdAt: at(11, 4, 16),
  createdBy: { id: PEOPLE[2]!.id, name: 'Demo Fitter' },
  may: { alteration: false, revision: true },
}
export const RESULT_TO_ALTER: FittingResult = { ...RESULT_ALTER, id: uid('6901', 2), alteration: null, promise: { current: '2026-12-04', byAlteration: '2026-12-09' }, may: { alteration: true, revision: true } }
export const RESULT_MOVED: FittingResult = { ...RESULT_ALTER, promise: { current: '2026-12-04', byAlteration: '2026-12-09' } }

export const FITTINGS: FittingsTab = { profileId: PROFILE_ID, riderName: RECORD.riderName, garmentType: 'JACKET', appointments: APPOINTMENTS, results: [RESULT_MOVED], nextFittingAt: at(11, 18, 10), started: true, may: { book: true, record: true }, /* B-W2b-F38: off by default */ remindersEnabled: false }
export const FITTINGS_OFF: FittingsTab = { ...FITTINGS, appointments: [APPOINTMENTS[2]!], results: [], nextFittingAt: null, started: false, may: { book: false, record: false } }
export const FITTINGS_EMPTY: FittingsTab = { ...FITTINGS, appointments: [], results: [], nextFittingAt: null }

// ---- photos (B-W2b-171) -----------------------------------------------------------------------------------------------------

export const SENT: Sent = {
  profile: { id: REV2.id, riderName: RECORD.riderName, garmentType: 'JACKET', latestRevision: 3 },
  revisions: [
    {
      id: REV2.id,
      revision: 2,
      submittedAt: at(10, 28, 16, 20),
      takenBy: 'Demo Rider Due (by link)',
      link: { id: uid('7101', 1), email: 'rider.due@example.com', contactName: 'Demo Rider Due' },
      notice: { id: uid('7102', 1), label: 'Privacy notice for riders v3', at: at(10, 28, 16, 2) },
      measurements: REV2.measurements,
      photos: [
        { view: 'FRONT', fileId: uid('7103', 1), status: 'AVAILABLE' },
        { view: 'SIDE', fileId: uid('7103', 2), status: 'AVAILABLE' },
        { view: 'BACK', fileId: uid('7103', 3), status: 'QUARANTINED' },
      ],
      photosDeleteAfter: null,
    },
  ],
  links: [
    { id: uid('7101', 1), recordId: REV1.id, email: 'rider.due@example.com', createdAt: at(10, 25, 10), expiresAt: at(11, 8, 10), uses: 1, maxUses: 1, revoked: false, photos: 'REQUIRED' },
    { id: uid('7101', 2), recordId: REV3.id, email: 'rider.due@example.com', createdAt: at(11, 12, 17), expiresAt: at(11, 26, 17), uses: 0, maxUses: 1, revoked: false, photos: 'OPTIONAL' },
  ],
}
export const SENT_EMPTY: Sent = { ...SENT, revisions: [], links: [] }

/** A made-up picture of a body outline (no person), for the photo opened. */
export const PHOTO_SRC =
  'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 400"><rect width="300" height="400" fill="gray"/><circle cx="150" cy="70" r="34" fill="lightgray"/><rect x="100" y="110" width="100" height="150" rx="30" fill="lightgray"/><text x="150" y="380" font-size="20" text-anchor="middle" fill="white">Demo</text></svg>')

// ---- proofs, repeat, worksheet -------------------------------------------------------------------------------------------

export const PROOFS: ProofLine[] = [
  { key: 'p1', quoteId: uid('6603', 1), number: 'QT-DEMO-0011', revision: 2, name: 'Livery front and back.pdf', shape: 'PDF', state: 'READY', shared: true, sentAt: at(10, 29, 15), accepted: { signer: 'Demo Team Manager', at: at(10, 31, 9) } },
  { key: 'p2', quoteId: uid('6603', 1), number: 'QT-DEMO-0011', revision: 2, name: 'Number plate colours.png', shape: 'PICTURE', state: 'READY', shared: true, sentAt: at(10, 29, 15), accepted: null },
  { key: 'p3', quoteId: uid('6603', 1), number: 'QT-DEMO-0011', revision: 3, name: 'Sponsor logo sleeve v2.pdf', shape: 'PDF', state: 'CHECKING', shared: false, sentAt: null, accepted: null },
]

export const REPEAT: RepeatFacts = { latest: { id: REV3.id, revision: 3, takenAt: REV3.takenAt, takenOn: '2026-11-12', months: 0, old: false, review: 'WAITING' }, reMeasure: null, earlier: units }
export const REPEAT_OLD: RepeatFacts = { latest: { id: REV3.id, revision: 3, takenAt: at(9, 2, 10, 0, 2025), takenOn: '2025-09-02', months: 14, old: true, review: 'CONFIRMED' }, reMeasure: 'old', earlier: units }

/** A one-page made-up PDF (the worksheet's look is the API's renderer). */
export function demoWorksheetPdf(title: string): Uint8Array {
  const text = `BT /F1 18 Tf 72 770 Td (${title}) Tj 0 -26 Td /F1 11 Tf (Made-up design data: measures, base size, fit notes, signatures) Tj ET`
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>', `<< /Length ${text.length} >>\nstream\n${text}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((object, index) => {
    offsets.push(body.length)
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return new TextEncoder().encode(body)
}
