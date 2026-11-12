import { createElement, type ReactNode } from 'react'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { permissionCheck } from '../../../../lib/session/session'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER } from '../../../../shell/design-data'
import { officeNavFor } from '../../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../../shell/office/view/OfficeShellView'
import type { Choices, ListAnswer, SampleRow } from '../api'

/**
 * Made-up data for SCR-222's design cases (B-W2b-347): an invented company ("Officina Demo"), invented suppliers, styles, sample
 * rounds, materials and sample orders. Nothing here is a real supplier, product, price or document. Design-only (only fixtures
 * and tests import it).
 */

export const uid = (block: string, n: number) => `0190f0e2-${block.padStart(4, '0').slice(-4)}-7000-8000-${String(n).padStart(12, '0')}`
export const TODAY = '2026-11-12'
export const NOW = '2026-11-12T08:40:00.000Z'
export const PREFIX = '/w/DEMO'
export const COMPANY = DEMO_COMPANIES[0]

const template = (key: string): string[] => [...(templateOf(key)?.permissions ?? []), 'home.view']

/** The roles the design reads: the buyer drafts and sees the cost; the planner and the warehouse look without the cost; sales has no purchasing read. */
export const SOURCING_ROLES_DEMO = {
  buyer: [...template('buyer'), 'money.cost'],
  planner: template('planner'),
  warehouse: template('warehouse'),
  sales: template('sales'),
} as const
export type SourcingRoleDemo = keyof typeof SOURCING_ROLES_DEMO

/** The Office shell around the page (the role's navigation, this page's place), as the page sees it. */
export function inSourcingShell(page: ReactNode, role: SourcingRoleDemo): ReactNode {
  const shell: OfficeShellViewModel = {
    nav: officeNavFor(permissionCheck([...SOURCING_ROLES_DEMO[role]])),
    path: '/purchasing/sourcing',
    switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: [], site: null, path: '/purchasing/sourcing' },
    user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
    tenantTag: DEMO_TAG,
    banners: [],
  }
  return createElement(OfficeShellView, { model: shell }, page)
}

const SITE = { id: uid('9201', 1), code: 'OD1', name: 'Officina Demo · Laboratorio' }
const TANNERY = { id: uid('9202', 1), code: 'F-DEMO-01', name: 'Conceria Esempio S.r.l.', currency: 'EUR', language: 'it' }
const WEAVER = { id: uid('9202', 2), code: 'F-DEMO-02', name: 'Tessitura Demo S.p.A.', currency: 'EUR', language: 'it' }
const TRIMS = { id: uid('9202', 3), code: 'F-DEMO-03', name: 'Example Trims GmbH', currency: 'EUR', language: 'en' }
export const STYLE_JKT = { id: uid('9203', 1), code: 'GIA-DEMO-01', name: 'Giacca Demo Touring' }
export const STYLE_PNT = { id: uid('9203', 2), code: 'PNT-DEMO-02', name: 'Pantalone Demo Rider' }
const ROUND_PROTO = { id: uid('9204', 1), number: 'SR-2026-0007', kind: 'PROTO' as const, roundNo: 1, stage: 'REQUESTED' as const }
const ROUND_FIT = { id: uid('9204', 2), number: 'SR-2026-0009', kind: 'FIT' as const, roundNo: 2, stage: 'IN_MAKING' as const }
const LEATHER = { id: uid('9205', 1), code: 'PEL-DEMO-12', name: 'Pelle bovina Demo 1,2 mm' }
const LINING = { id: uid('9205', 2), code: 'FOD-DEMO-03', name: 'Fodera rete Demo' }
const MESH = { id: uid('9205', 3), code: 'TES-DEMO-07', name: 'Tessuto Cordura Demo' }

export const CHOICES: Choices = {
  sites: [SITE],
  defaultSiteId: SITE.id,
  suppliers: [TANNERY, WEAVER, TRIMS],
  styles: [
    { ...STYLE_JKT, lifecycle: 'SAMPLING', rounds: [ROUND_PROTO, ROUND_FIT] },
    { ...STYLE_PNT, lifecycle: 'DEVELOPMENT', rounds: [] },
  ],
  materials: [
    { ...LEATHER, kind: 'LEATHER', baseUom: 'FT2', purchaseUom: 'HIDE', units: ['FT2', 'M2', 'DM2', 'HIDE'], colours: [{ id: uid('9206', 1), code: 'NER', name: 'Nero' }, { id: uid('9206', 2), code: 'COG', name: 'Cognac' }] },
    { ...LINING, kind: 'LINING', baseUom: 'M', purchaseUom: 'ROLL', units: ['M', 'CM', 'MM', 'ROLL'], colours: [] },
    { ...MESH, kind: 'TEXTILE', baseUom: 'M', purchaseUom: 'M', units: ['M', 'CM', 'MM'], colours: [{ id: uid('9206', 3), code: 'GRI', name: 'Grigio' }] },
  ],
  complete: true,
}

const row = (n: number, over: Partial<SampleRow>): SampleRow => ({
  id: uid('9207', n),
  number: `PO-2026-${String(40 + n).padStart(4, '0')}`,
  companyId: COMPANY.id,
  siteId: SITE.id,
  partyId: TANNERY.id,
  supplierName: TANNERY.name,
  status: 'DRAFT',
  revision: 1,
  currency: 'EUR',
  orderDate: '2026-11-10',
  requestedDate: null,
  style: STYLE_JKT,
  round: null,
  items: [],
  lineCount: 0,
  netAmount: 0,
  sentAt: null,
  updatedAt: NOW,
  version: 3,
  ...over,
})

export const DRAFT_HIDES = row(1, {
  round: ROUND_PROTO,
  items: [
    { code: LEATHER.code, name: LEATHER.name, kind: 'LEATHER', description: 'Pelle campione' },
    { code: LEATHER.code, name: LEATHER.name, kind: 'LEATHER', description: 'Cartella colori · Nero e cognac' },
  ],
  lineCount: 2,
  netAmount: 46_200,
  requestedDate: '2026-11-24',
})
export const SENT_SWATCHES = row(2, {
  partyId: WEAVER.id,
  supplierName: WEAVER.name,
  status: 'SENT',
  orderDate: '2026-11-05',
  round: ROUND_FIT,
  items: [
    { code: MESH.code, name: MESH.name, kind: 'TEXTILE', description: 'Campione di materiale · 30 × 30 cm' },
    { code: LINING.code, name: LINING.name, kind: 'LINING', description: 'Campione di materiale' },
    { code: MESH.code, name: MESH.name, kind: 'TEXTILE', description: 'Cartella colori' },
  ],
  lineCount: 4,
  netAmount: 8_750,
  sentAt: '2026-11-05T09:12:00.000Z',
})
export const CONFIRMED_CARDS = row(3, {
  partyId: TRIMS.id,
  supplierName: TRIMS.name,
  status: 'CONFIRMED',
  orderDate: '2026-10-28',
  style: STYLE_PNT,
  items: [{ code: MESH.code, name: MESH.name, kind: 'TEXTILE', description: 'Colour card' }],
  lineCount: 1,
  netAmount: 0,
  sentAt: '2026-10-28T14:02:00.000Z',
})
export const PARTLY = row(4, { status: 'PARTLY_RECEIVED', orderDate: '2026-10-20', items: [{ code: LEATHER.code, name: LEATHER.name, kind: 'LEATHER', description: 'Pelle campione' }], lineCount: 1, netAmount: 22_050, sentAt: '2026-10-20T10:00:00.000Z' })

export const ROWS: readonly SampleRow[] = [DRAFT_HIDES, SENT_SWATCHES, CONFIRMED_CARDS, PARTLY]

export const listAnswer = (orders: readonly SampleRow[] = ROWS, nextCursor: string | null = null): ListAnswer => ({ orders: [...orders], nextCursor, readAt: NOW })

/** The same rows as a person without the cost grain reads them (the value is dropped by the server). */
export const withoutCost = (orders: readonly SampleRow[]): SampleRow[] =>
  orders.map((entry) => {
    const copy: SampleRow = { ...entry }
    delete copy.netAmount
    return copy
  })

export const MANY: readonly SampleRow[] = Array.from({ length: 50 }, (_, index) =>
  row(10 + index, { number: `PO-2026-${String(100 + index).padStart(4, '0')}`, status: index % 3 === 0 ? 'SENT' : 'DRAFT', items: DRAFT_HIDES.items, lineCount: 2 + (index % 4), netAmount: 10_000 + index * 731 }),
)

export const IDS = { site: SITE.id, tannery: TANNERY.id, weaver: WEAVER.id, styleJkt: STYLE_JKT.id, styleRound: ROUND_PROTO.id, leather: LEATHER.id, lining: LINING.id, mesh: MESH.id, black: uid('9206', 1) }
