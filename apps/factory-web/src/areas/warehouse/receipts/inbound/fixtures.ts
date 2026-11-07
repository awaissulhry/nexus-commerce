import { createElement, Fragment } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { canOf, inShell, PREFIX, SITE, SITE_SOUTH, SUPPLIERS, TIME_ZONE, uid, type Role } from '../../../_shared/buying/fixtures'
import type { InboundBoardData, InboundCard } from './api'
import type { InboundModel } from './model'
import { InboundBoardView, InboundMenu } from './view/InboundBoardView'

/**
 * SCR-063-inbound — Warehouse › Receipts, the inbound board (B-W2b-182; SCM-110; design warehouse.receipts sec:rc-inbound and
 * h.more "Inbound board on / off (W2b)") with made-up data only: seven day columns per site, a card per delivery — a
 * supplier's ship notice (announced or in transit, its packing list's verdict, the supplier's note and our dock note) or a
 * confirmed order still without one; a late notice on the first day; Receive (held without inventory.receive) and the dock
 * note dialog. Every state: loading, failed, nothing expected, no permission, switched off, two sites. Roles: Warehouse,
 * Buyer (reads, does not receive).
 */

const TODAY = '2026-11-09'
const DAYS = ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15']
const po = (n: number) => ({ id: uid('8181', n), number: `PO-2026-${String(n).padStart(4, '0')}` })
const supplier = (key: keyof typeof SUPPLIERS) => ({ id: SUPPLIERS[key].id, name: SUPPLIERS[key].legalName })

const notice = (n: number, over: Partial<NonNullable<InboundCard['shipNotice']>> = {}): NonNullable<InboundCard['shipNotice']> => ({
  id: uid('9191', n),
  number: `ASN-2026-${String(n).padStart(4, '0')}`,
  state: 'ANNOUNCED',
  words: { it: 'Annunciato', en: 'Announced' },
  shipDate: '2026-11-10',
  carrier: 'Corriere Esempio',
  trackingNumber: `CE-00${n}482`,
  parcels: 2,
  supplierRef: `SP-${n}`,
  ddtNumber: `DDT-${40 + n}`,
  hides: 0,
  verdict: 'OK',
  supplierNote: null,
  version: 3,
  ...over,
})

const CARDS: InboundCard[] = [
  {
    id: `asn:${uid('9191', 7)}`,
    kind: 'SHIP_NOTICE',
    day: '2026-11-09',
    late: true,
    siteId: SITE.id,
    supplier: supplier('protector'),
    purchaseOrder: po(31),
    shipNotice: notice(7, { state: 'IN_TRANSIT', words: { it: 'In viaggio', en: 'In transit' }, shipDate: '2026-11-05' }),
    lines: 1,
    items: [{ code: 'DEMO-PRT-03', name: 'Protezione spalla livello 2', quantity: '120.0000', uom: 'PCS' }],
    dockNote: 'Chiamare il magazzino Sud prima dello scarico',
  },
  {
    id: `asn:${uid('9191', 12)}`,
    kind: 'SHIP_NOTICE',
    day: '2026-11-10',
    late: false,
    siteId: SITE.id,
    supplier: supplier('tannery'),
    purchaseOrder: po(42),
    shipNotice: notice(12, { state: 'IN_TRANSIT', words: { it: 'In viaggio', en: 'In transit' }, hides: 5, verdict: 'NOT_AS_ORDERED', supplierNote: 'La pelle 2231-004 è scelta B, come concordato.' }),
    lines: 2,
    items: [
      { code: 'DEMO-LEA-01', name: 'Nappa bovina 1,2 mm', quantity: '105.0000', uom: 'FT2' },
      { code: 'DEMO-PRT-03', name: 'Protezione spalla livello 2', quantity: '24.0000', uom: 'PCS' },
    ],
    dockNote: null,
  },
  {
    id: `asn:${uid('9191', 13)}`,
    kind: 'SHIP_NOTICE',
    day: '2026-11-12',
    late: false,
    siteId: SITE.id,
    supplier: supplier('tannery'),
    purchaseOrder: po(44),
    shipNotice: notice(13, { shipDate: '2026-11-11', hides: 38, verdict: 'CHECK' }),
    lines: 4,
    items: [
      { code: 'DEMO-LEA-01', name: 'Nappa bovina 1,2 mm', quantity: '412.5000', uom: 'FT2' },
      { code: 'DEMO-LEA-01', name: 'Nappa bovina 1,2 mm', quantity: '96.0000', uom: 'FT2' },
      { code: 'DEMO-FOD-02', name: 'Fodera rete traspirante', quantity: '150.0000', uom: 'M' },
    ],
    dockNote: 'Banchina 2, serve il muletto',
  },
  {
    id: `po:${po(45).id}:2026-11-12`,
    kind: 'ORDER',
    day: '2026-11-12',
    late: false,
    siteId: SITE.id,
    supplier: supplier('fabric'),
    purchaseOrder: po(45),
    shipNotice: null,
    lines: 1,
    items: [{ code: 'DEMO-FOD-02', name: 'Fodera rete traspirante', quantity: '300.0000', uom: 'M' }],
    dockNote: null,
  },
  {
    id: `po:${po(47).id}:2026-11-14`,
    kind: 'ORDER',
    day: '2026-11-14',
    late: false,
    siteId: SITE.id,
    supplier: supplier('protector'),
    purchaseOrder: po(47),
    shipNotice: null,
    lines: 2,
    items: [
      { code: 'DEMO-PRT-03', name: 'Protezione spalla livello 2', quantity: '200.0000', uom: 'PCS' },
      { code: 'DEMO-ZIP-04', name: 'Zip divisibile 60 cm', quantity: '500.0000', uom: 'PCS' },
    ],
    dockNote: null,
  },
]

const SOUTH_CARD: InboundCard = {
  id: `asn:${uid('9191', 21)}`,
  kind: 'SHIP_NOTICE',
  day: '2026-11-11',
  late: false,
  siteId: SITE_SOUTH.id,
  supplier: supplier('fabric'),
  purchaseOrder: po(51),
  shipNotice: notice(21, { hides: 0 }),
  lines: 1,
  items: [{ code: 'DEMO-FOD-02', name: 'Fodera rete traspirante', quantity: '80.0000', uom: 'M' }],
  dockNote: null,
}

const site = (entry: typeof SITE) => ({ id: entry.id, code: entry.code, name: entry.name })
const data = (over: Partial<InboundBoardData> = {}): InboundBoardData => ({ asOf: '2026-11-09T08:41:00.000Z', from: TODAY, days: DAYS, sites: [site(SITE)], cards: CARDS, complete: true, ...over })

export interface InboundCase {
  role: Role
  model: InboundModel
}

function inboundCase(role: Role, over: Partial<InboundModel> = {}): InboundCase {
  return { role, model: { prefix: PREFIX, on: true, board: { status: 'ready', value: data() }, today: TODAY, canReceive: canOf(role).receive, timeZone: TIME_ZONE, noting: null, ...over } }
}

function InboundDesign({ model }: { model: InboundCase }) {
  const page = createElement(
    Fragment,
    null,
    createElement('div', { style: { display: 'flex', justifyContent: 'flex-end' } }, createElement(InboundMenu, { on: model.model.on })),
    createElement(InboundBoardView, { model: model.model }),
  )
  return inShell('/warehouse/receipts', createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } }, page), model.role)
}

const noting = (text: string, extra: { saving?: boolean; problem?: string | null } = {}) => ({ card: CARDS[2]!, text, saving: extra.saving ?? false, problem: extra.problem ?? null })

export const designScreen = defineDesignScreen<InboundCase>({
  screen: 'SCR-063-inbound',
  title: 'Receipts › Inbound board (expected arrivals by day and site)',
  view: InboundDesign,
  cases: [
    { id: 'board', label: 'Seven days at one site: ship notices (in transit, announced, a late one on the first day) and confirmed orders without one', model: inboundCase('warehouse'), note: 'A card opens its PO; Receive opens the receiving page filled from the notice (SCR-061).' },
    { id: 'two-sites', label: '“All sites” in the top bar: a row per site', model: inboundCase('warehouse', { board: { status: 'ready', value: data({ sites: [site(SITE), site(SITE_SOUTH)], cards: [...CARDS, SOUTH_CARD] }) } }) },
    { id: 'buyer', label: 'Buyer: reads the board, Receive and the dock note held with the reason', model: inboundCase('buyer') },
    { id: 'dock-note', label: 'Note for the dock (our own; the supplier never reads it)', model: inboundCase('warehouse', { noting: noting('Banchina 2, serve il muletto') }) },
    { id: 'dock-note-saving', label: 'Saving the dock note', model: inboundCase('warehouse', { noting: noting('Banchina 2, serve il muletto', { saving: true }) }) },
    { id: 'dock-note-refused', label: 'The dock note was refused: the notice changed meanwhile', model: inboundCase('warehouse', { noting: noting('Banchina 3', { problem: 'problem.changed' }) }) },
    { id: 'empty', label: 'Nothing expected in the next seven days', model: inboundCase('warehouse', { board: { status: 'ready', value: data({ cards: [] }) } }) },
    { id: 'loading', label: 'Loading: the days are drawn, the cards are skeletons', model: inboundCase('warehouse', { board: { status: 'loading' } }) },
    { id: 'error', label: "The deliveries couldn't be read (never drawn as an empty board)", model: inboundCase('warehouse', { board: { status: 'error', problem: 'problem.offline' } }) },
    { id: 'no-permission', label: 'No inventory.stock.view: the section says which permission is missing', model: inboundCase('sales', { board: { status: 'forbidden' } }) },
    { id: 'off', label: 'Switched off on this device: only the ⋯ menu offers it again', model: inboundCase('warehouse', { on: false }) },
  ],
})
