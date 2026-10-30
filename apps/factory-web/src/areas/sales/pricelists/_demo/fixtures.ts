import { createElement, type ReactNode } from 'react'
import { permissionCheck } from '../../../../lib/session/session'
import { designScreen as panelsScreen } from '../../../../record-panels/fixtures'
import type { RecordPanelsViewModel } from '../../../../record-panels/model'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER, rolePermissions } from '../../../../shell/design-data'
import { officeNavFor } from '../../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../../shell/office/view/OfficeShellView'
import type { PartyRow, StyleDetail, StyleRow } from '../../quotes/api'
import type { CompareAnswer, PriceEntry, PriceListDetail, PriceListRow, PriceVersion } from '../api'
import { abilitiesOf, emptyNewList, NO_FILTERS, type PriceListAbilities } from '../model'
import type { NewListModel, PriceListsViewModel } from '../list/list-model'
import type { PriceListRecordModel } from '../record/record-model'

/**
 * Made-up price lists for the design cases of SCR-106 (B-W2a-49): "Demo", "Esempio", "Prova" names, invented codes and
 * prices. Nothing here is a real customer, list or price. Design-only (a fixtures file: only fixtures and tests import
 * it); it exports no `designScreen`, so the design index skips it.
 */

export const PREFIX = '/w/DEMO'
export const TODAY = '2026-10-30'
export const NOW = '2026-10-30T08:42:00.000Z'
const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`

export type PriceListRole = 'owner' | 'sales' | 'finance' | 'readOnly' | 'planner'

/** A role's permissions as the session lists them: the template's, with its money grains as `money.*`. */
export function rolePerms(role: PriceListRole): string[] {
  switch (role) {
    case 'owner':
      return [...rolePermissions('owner'), 'money.price', 'money.cost', 'money.margin']
    case 'sales':
      return [...rolePermissions('sales'), 'money.price', 'money.margin']
    case 'finance':
      return [...rolePermissions('finance'), 'money.price', 'money.cost', 'money.margin']
    case 'readOnly':
      return rolePermissions('read_only')
    case 'planner':
      return rolePermissions('planner')
  }
}

export const can = (role: PriceListRole): PriceListAbilities => abilitiesOf(rolePerms(role))

/** The Office shell around a page at this address (the role's navigation). */
export function inShell(path: string, page: ReactNode, role: PriceListRole): ReactNode {
  const shell: OfficeShellViewModel = {
    nav: officeNavFor(permissionCheck(rolePerms(role))),
    path,
    switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: [], site: null, path },
    user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
    tenantTag: DEMO_TAG,
    banners: [],
  }
  return createElement(OfficeShellView, { model: shell }, page)
}

// ---- lists --------------------------------------------------------------------------------------------------------------

const shown = (n: number, revision: number, status: 'DRAFT' | 'ACTIVE', validFrom: string | null, validTo: string | null) => ({ id: uid('6106', n), revision, status, validFrom, validTo })

const row = (n: number, over: Partial<PriceListRow>): PriceListRow => ({
  id: uid('6105', n),
  companyId: DEMO_COMPANIES[0]!.id,
  code: `PL-DEMO-${n}`,
  name: `Listino Demo ${n}`,
  kind: 'CUSTOMER',
  currency: 'EUR',
  baseList: null,
  state: 'IN_FORCE',
  status: 'ACTIVE',
  shownVersion: shown(n * 10 + 1, 1, 'ACTIVE', '2026-01-01', null),
  draftVersionId: null,
  stylesPriced: 12,
  customers: 3,
  startsSoon: false,
  endsSoon: false,
  version: 3,
  updatedAt: '2026-10-28T10:00:00.000Z',
  ...over,
})

const BASE_REF = { id: uid('6105', 1), code: 'BASE-EUR', name: 'Listino base Demo 2026' }

export const LIST_ROWS: PriceListRow[] = [
  row(1, { code: 'BASE-EUR', name: 'Listino base Demo 2026', kind: 'BASE', companyId: null, customers: 0, stylesPriced: 24, shownVersion: shown(11, 2, 'ACTIVE', '2026-03-01', null), version: 6 }),
  row(2, { code: 'MODA-DEMO', name: 'Moda Demo S.r.l. — 2026', baseList: BASE_REF, customers: 1, stylesPriced: 9, shownVersion: shown(21, 1, 'ACTIVE', '2026-01-15', '2026-11-20'), endsSoon: true, draftVersionId: uid('6106', 22) }),
  row(3, { code: 'GRUPPO-DEALER', name: 'Gruppo rivenditori Esempio', kind: 'GROUP', baseList: BASE_REF, customers: 7, stylesPriced: 18 }),
  row(4, { code: 'FIERA-2027', name: 'Fiera Prova primavera 2027', kind: 'CONTRACT', state: 'SCHEDULED', customers: 2, stylesPriced: 6, shownVersion: shown(41, 1, 'ACTIVE', '2026-11-15', '2027-03-31'), startsSoon: true }),
  row(5, { code: 'PROVA-CH', name: 'Prova Svizzera', currency: 'CHF', state: 'DRAFT', customers: 0, stylesPriced: 0, shownVersion: shown(51, 1, 'DRAFT', null, null), draftVersionId: uid('6106', 51) }),
  row(6, { code: 'ESEMPIO-2025', name: 'Esempio Moto — 2025', state: 'EXPIRED', customers: 0, stylesPriced: 11, shownVersion: shown(61, 1, 'ACTIVE', '2025-01-01', '2025-12-31') }),
]
export const ARCHIVED_ROW: PriceListRow = row(7, { code: 'VECCHIO-2024', name: 'Listino vecchio 2024', state: 'ARCHIVED', status: 'ARCHIVED', customers: 0, stylesPriced: 8, shownVersion: shown(71, 1, 'ACTIVE', '2024-01-01', '2024-12-31') })

export const TILES = { inForce: 3, startingIn30Days: 1, endingIn30Days: 1 }

export function newListModel(over: Partial<NewListModel> = {}, draft: Partial<NewListModel['draft']> = {}): NewListModel {
  return {
    draft: { ...emptyNewList(DEMO_COMPANIES[0]!.id), ...draft },
    companies: DEMO_COMPANIES.map((company) => ({ id: company.id, name: company.name })),
    lists: LIST_ROWS,
    busy: false,
    problem: null,
    ...over,
  }
}

export function listModel(role: PriceListRole, over: Partial<PriceListsViewModel> = {}): PriceListsViewModel {
  return {
    prefix: PREFIX,
    can: can(role),
    filters: NO_FILTERS,
    rows: { items: LIST_ROWS, problem: null },
    tiles: TILES,
    asOf: NOW,
    live: 'live',
    updates: 0,
    notice: null,
    selected: [],
    newList: null,
    dialog: null,
    busy: false,
    ...over,
  }
}

// ---- one list: MODA-DEMO, version 1 in force, version 2 a draft -------------------------------------------------------

const version = (n: number, over: Partial<PriceVersion>): PriceVersion => ({
  id: uid('6106', n),
  revision: 1,
  status: 'ACTIVE',
  validFrom: '2026-01-15',
  validTo: '2026-11-20',
  activatedAt: '2026-01-14T15:00:00.000Z',
  activatedById: DEMO_USER.id,
  note: null,
  entries: 4,
  version: 2,
  createdAt: '2026-01-10T09:00:00.000Z',
  updatedAt: '2026-01-14T15:00:00.000Z',
  ...over,
})

export const V1 = version(21, { validTo: null })
export const V2 = version(22, { revision: 2, status: 'DRAFT', validFrom: '2026-11-21', validTo: null, activatedAt: null, activatedById: null, note: 'Aumento autunno: +4 % sulle giacche.', entries: 5, version: 4 })

const styles = {
  jkt1: { id: uid('6107', 1), code: 'JKT-DEMO-01', name: 'Giacca Demo Strada', status: 'ACTIVE' },
  jkt2: { id: uid('6107', 2), code: 'JKT-DEMO-02', name: 'Giacca Demo Pista', status: 'ACTIVE' },
  pnt1: { id: uid('6107', 3), code: 'PNT-DEMO-01', name: 'Pantalone Demo Touring', status: 'ACTIVE' },
  glv1: { id: uid('6107', 4), code: 'GLV-DEMO-01', name: 'Guanto Demo Estate', status: 'ACTIVE' },
}
const colours = {
  blk: { id: uid('6108', 1), code: 'BLK', name: 'Nero' },
  red: { id: uid('6108', 2), code: 'RED', name: 'Rosso' },
}

const entry = (n: number, style: (typeof styles)[keyof typeof styles], colour: (typeof colours)[keyof typeof colours] | null, unitPrice: string, standardCost: string | null, marginPct: string | null, belowFloor = false): PriceEntry => ({
  id: uid('6109', n),
  styleId: style.id,
  style: { code: style.code, name: style.name, status: style.status },
  colourwayId: colour?.id ?? null,
  colourway: colour ? { code: colour.code, name: colour.name } : null,
  unitPrice,
  standardCost,
  marginPct,
  belowFloor,
  version: 1,
})

export const V1_ENTRIES: PriceEntry[] = [
  entry(1, styles.jkt1, null, '420', '287.40', '31.5714'),
  entry(2, styles.jkt1, colours.red, '435', '287.40', '33.9310'),
  entry(3, styles.jkt2, null, '399', '312.10', '21.7794', true),
  entry(4, styles.pnt1, null, '260', '171.00', '34.2308'),
]
export const V2_ENTRIES: PriceEntry[] = [
  entry(11, styles.jkt1, null, '436.80', '287.40', '34.2033'),
  entry(12, styles.jkt1, colours.red, '452.40', '287.40', '36.4721'),
  entry(13, styles.jkt2, null, '414.96', '312.10', '24.7879', true),
  entry(14, styles.pnt1, null, '260', '171.00', '34.2308'),
  entry(15, styles.glv1, null, '69.50', '31.20', '55.1079'),
]

/** The same rows as a role without cost (sales: margin % only) or without any money grain sees them. */
export const withoutCost = (entries: readonly PriceEntry[]): PriceEntry[] => entries.map(({ standardCost: _cost, ...rest }) => rest as PriceEntry)
export const withoutMoney = (entries: readonly PriceEntry[]): PriceEntry[] => entries.map(({ standardCost: _cost, unitPrice: _price, marginPct: _margin, belowFloor: _floor, ...rest }) => rest as PriceEntry)

export const CUSTOMERS: PriceListDetail['customers'] = [{ id: uid('6110', 1), code: 'MODA-DEMO', legalName: 'Moda Demo S.r.l.', status: 'ACTIVE', companyId: null, version: 5 }]
export const GROUP_CUSTOMERS: PriceListDetail['customers'] = [
  { id: uid('6110', 2), code: 'DEALER-ESEMPIO', legalName: 'Esempio Moto Ricambi S.n.c.', status: 'ACTIVE', companyId: null, version: 2 },
  { id: uid('6110', 3), code: 'DEALER-PROVA', legalName: 'Prova Racing S.r.l.', status: 'ACTIVE', companyId: null, version: 3 },
  { id: uid('6110', 4), code: 'DEALER-DEMO', legalName: 'Demo Bikers di Rossi', status: 'BLOCKED', companyId: null, version: 7 },
]

export const DETAIL: PriceListDetail = {
  ...LIST_ROWS[1]!,
  shownVersion: { id: V1.id, revision: 1, status: 'ACTIVE', validFrom: '2026-01-15', validTo: null },
  endsSoon: false,
  note: 'Listino concordato a gennaio con Moda Demo.',
  createdAt: '2026-01-10T09:00:00.000Z',
  createdById: DEMO_USER.id,
  versions: [V2, V1],
  customers: CUSTOMERS,
  fallbackOf: [],
}
export const DETAIL_IN_FORCE_ONLY: PriceListDetail = { ...DETAIL, draftVersionId: null, versions: [V1] }
export const GROUP_DETAIL: PriceListDetail = { ...LIST_ROWS[2]!, note: null, createdAt: '2026-02-01T09:00:00.000Z', createdById: DEMO_USER.id, versions: [version(31, { validFrom: '2026-02-01', validTo: null, entries: 18 })], customers: GROUP_CUSTOMERS, fallbackOf: [] }
export const BASE_DETAIL: PriceListDetail = {
  ...LIST_ROWS[0]!,
  note: null,
  createdAt: '2025-12-01T09:00:00.000Z',
  createdById: DEMO_USER.id,
  versions: [version(11, { revision: 2, validFrom: '2026-03-01', validTo: null, entries: 24 }), version(12, { revision: 1, validFrom: '2026-01-01', validTo: '2026-02-28', entries: 22 })],
  customers: [],
  fallbackOf: [
    { id: uid('6105', 2), code: 'MODA-DEMO', name: 'Moda Demo S.r.l. — 2026', kind: 'CUSTOMER', status: 'ACTIVE' },
    { id: uid('6105', 3), code: 'GRUPPO-DEALER', name: 'Gruppo rivenditori Esempio', kind: 'GROUP', status: 'ACTIVE' },
  ],
}
export const ARCHIVED_DETAIL: PriceListDetail = { ...ARCHIVED_ROW, note: null, createdAt: '2024-01-01T09:00:00.000Z', createdById: null, versions: [version(71, { validFrom: '2024-01-01', validTo: '2024-12-31' })], customers: [], fallbackOf: [] }

export const COMPARE: CompareAnswer = {
  before: { id: V1.id, revision: 1 },
  after: { id: V2.id, revision: 2 },
  changed: 4,
  rows: [
    { styleId: styles.jkt1.id, style: { ...styles.jkt1 }, colourwayId: null, colourway: null, before: '420', after: '436.80', change: 'CHANGED', changePct: '4.0000' },
    { styleId: styles.jkt1.id, style: { ...styles.jkt1 }, colourwayId: colours.red.id, colourway: { ...colours.red }, before: '435', after: '452.40', change: 'CHANGED', changePct: '4.0000' },
    { styleId: styles.jkt2.id, style: { ...styles.jkt2 }, colourwayId: null, colourway: null, before: '399', after: '414.96', change: 'CHANGED', changePct: '4.0000' },
    { styleId: styles.pnt1.id, style: { ...styles.pnt1 }, colourwayId: null, colourway: null, before: '260', after: '260', change: 'SAME', changePct: '0.0000' },
    { styleId: styles.glv1.id, style: { ...styles.glv1 }, colourwayId: null, colourway: null, before: null, after: '69.50', change: 'ADDED', changePct: null },
  ],
}

export const STYLE_ROWS: StyleRow[] = [
  { id: styles.glv1.id, code: styles.glv1.code, name: styles.glv1.name, season: 'SS27', sizes: ['S', 'M', 'L', 'XL'], ppeClass: 'II', ppeCategory: 'II', mtmAllowed: false, status: 'ACTIVE', revisionState: 'RELEASED' },
  { id: uid('6107', 5), code: 'VST-DEMO-01', name: 'Gilet Demo Airbag', season: 'SS27', sizes: ['S', 'M', 'L'], ppeClass: 'II', ppeCategory: 'II', mtmAllowed: false, status: 'ACTIVE', revisionState: 'DRAFT' },
]
export const STYLE_DETAIL: StyleDetail = {
  ...STYLE_ROWS[1]!,
  colourways: [
    { id: uid('6108', 11), code: 'BLK', name: 'Nero', colour: { hex: null }, status: 'ACTIVE', offeredSizes: ['S', 'M', 'L'] },
    { id: uid('6108', 12), code: 'YEL', name: 'Giallo fluo', colour: { hex: null }, status: 'ACTIVE', offeredSizes: ['M', 'L'] },
  ],
  matrix: { sizes: [{ code: 'S', label: 'S' }, { code: 'M', label: 'M' }, { code: 'L', label: 'L' }] },
}

const party = (n: number, legalName: string, code: string, status = 'ACTIVE'): PartyRow => ({ id: uid('6110', n), code, legalName, tradeName: null, status, country: 'IT', taxMode: 'IT_B2B', vatNumber: `IT0000000000${n}`, city: 'Demo', vies: { state: 'NOT_APPLICABLE' } })
export const CUSTOMER_ROWS: PartyRow[] = [party(1, 'Moda Demo S.r.l.', 'MODA-DEMO'), party(5, 'Nuovo Prova S.p.A.', 'NUOVO-PROVA'), party(6, 'Esempio Abbigliamento Tecnico', 'ESEMPIO-AT'), party(7, 'Bloccato Demo S.r.l.', 'BLOCCATO-DEMO', 'BLOCKED')]

const conversation = panelsScreen.cases.find((item) => item.id === 'conversation')!.model as RecordPanelsViewModel
export const PANELS: RecordPanelsViewModel = { ...conversation, record: { type: 'PriceList', id: DETAIL.id, companyId: DETAIL.companyId }, title: `${DETAIL.code} · ${DETAIL.name}`, party: null }

export function recordModel(role: PriceListRole, over: Partial<PriceListRecordModel> = {}): PriceListRecordModel {
  const abilities = can(role)
  const entries = abilities.cost ? V2_ENTRIES : abilities.price ? withoutCost(V2_ENTRIES) : withoutMoney(V2_ENTRIES)
  return {
    prefix: PREFIX,
    tab: 'prices',
    today: TODAY,
    can: abilities,
    list: { status: 'ready', value: DETAIL },
    versionId: V2.id,
    prices: { answer: { version: V2, entries }, problem: null, loading: false },
    changedRows: { [V2.id]: 4 },
    asOf: NOW,
    live: 'live',
    changedAt: null,
    notice: null,
    busy: false,
    dialog: null,
    dialogProblem: null,
    q: '',
    selectedPrices: [],
    selectedCustomers: [],
    cells: {},
    stylePick: { query: '', results: STYLE_ROWS, problem: null, chosen: null, colourwayId: '', price: '' },
    customerPick: { query: '', results: CUSTOMER_ROWS, problem: null, picked: [] },
    compare: { beforeId: V1.id, afterId: V2.id, answer: COMPARE, problem: null, loading: false },
    panelsPreview: PANELS,
    ...over,
  }
}

/** The prices as version 1 (in force) shows them to a role. */
export function v1Prices(role: PriceListRole): PriceListRecordModel['prices'] {
  const abilities = can(role)
  const entries = abilities.cost ? V1_ENTRIES : abilities.price ? withoutCost(V1_ENTRIES) : withoutMoney(V1_ENTRIES)
  return { answer: { version: V1, entries }, problem: null, loading: false }
}
