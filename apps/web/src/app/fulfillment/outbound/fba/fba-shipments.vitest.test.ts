import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { FbaPlanView } from '@nexus/shared/fba-send'

import { buildAppNav } from '@/app/_shared/app-nav'
import { defaultView, pageQuery, productChoices, productSearchUrl, shipmentRow, tabLabel, viewOf } from './fbaShipments'

/**
 * The FBA shipments page (Fulfillment › Outbound, Owner 2026-10-08): every family's FBA drafts and shipments in one
 * list; `?view=` picks the tab, `?plan=` opens a shipment; "Add SKUs" searches the catalogue.
 */

const plan = (over: Partial<FbaPlanView> = {}): FbaPlanView => ({
  id: 'plan-1', name: 'Nexus IT 2026-10-08 #abc123', status: 'READY_TO_SHIP', step: 'TRACKING', source: 'matrix', amazonPlanId: 'wf1',
  market: 'IT', marketplaceId: 'APJ6JRA9NG5V4', from: { locationId: 'loc-1', code: 'IT-MAIN', name: 'Main' }, readyToShipOn: '2026-10-09',
  mixedBox: null, skus: 2, units: 30, shippedUnits: 0, lines: [], steps: [], options: null, choice: null,
  shipments: [{
    id: 's1', amazonShipmentId: 'sh1', shipmentConfirmationId: 'FBA15X', destinationFc: 'MXP5', status: 'WORKING', units: 30,
    boxes: [{ boxId: 'b1', items: [] }, { boxId: 'b2', items: [] }], transport: null, tracking: null, shippedAt: null,
  } as unknown as FbaPlanView['shipments'][number]],
  problems: [], message: null, nextCheckAt: null, createdAt: '2026-10-08T08:00:00Z', createdBy: 'me', confirmedAt: '2026-10-08T09:30:00Z',
  confirmedBy: 'me', cancelledAt: null,
  can: { edit: false, send: false, discard: false, choose: false, newOptions: false, retry: false, cancel: true },
  ...over,
})

describe('the URL', () => {
  it('?view= names a tab; anything else is none (the page picks)', () => {
    expect(viewOf('drafts')).toBe('drafts')
    expect(viewOf('done')).toBe('done')
    expect(viewOf('DRAFTS')).toBeNull()
    expect(viewOf(null)).toBeNull()
  })

  it('with no tab named: Drafts while there is one, else In progress, else Drafts', () => {
    expect(defaultView(null)).toBe('drafts')
    expect(defaultView({ drafts: 1, active: 4, done: 9 })).toBe('drafts')
    expect(defaultView({ drafts: 0, active: 4, done: 9 })).toBe('active')
    expect(defaultView({ drafts: 0, active: 0, done: 9 })).toBe('drafts')
  })

  it('a tab change closes the panel; opening and closing a shipment keeps the tab', () => {
    expect(pageQuery('view=drafts&plan=a', { view: 'active' })).toBe('?view=active')
    expect(pageQuery('view=drafts', { plan: 'b' })).toBe('?view=drafts&plan=b')
    expect(pageQuery('view=drafts&plan=b', { plan: null })).toBe('?view=drafts')
    expect(pageQuery('', { view: 'drafts', plan: 'd1' })).toBe('?view=drafts&plan=d1')
    expect(pageQuery('plan=x', { plan: null })).toBe('?')
  })
})

describe('the list', () => {
  it('one row in words: name, To, From, SKUs, units, boxes at Amazon, status, when it last moved', () => {
    const row = shipmentRow(plan(), { now: Date.parse('2026-10-08T12:00:00Z'), timeZone: 'UTC' })
    expect(row).toEqual({
      id: 'plan-1', name: 'Nexus IT 2026-10-08 #abc123', to: 'Amazon IT', from: 'IT-MAIN', skus: 2, units: 30, boxes: '2',
      status: 'Ready to ship', updated: '09:30', updatedAt: '2026-10-08T09:30:00Z',
    })
  })

  it('a draft: no boxes yet, no market or From is a dash, an old row without a name shows its id', () => {
    const row = shipmentRow(plan({ status: 'DRAFT', name: ' ', market: null, from: null, shipments: [], confirmedAt: null }), { timeZone: 'UTC' })
    expect(row).toMatchObject({ name: 'Plan #plan-1', to: '—', from: '—', boxes: '—', status: 'Draft' })
  })

  it('the tabs say Drafts · In progress · Done', () => {
    expect(['drafts', 'active', 'done'].map((v) => tabLabel(v as 'drafts'))).toEqual(['Drafts', 'In progress', 'Done'])
  })
})

describe('Add SKUs: the catalogue search', () => {
  it('searches by SKU or name, trimmed, 20 at a time', () => {
    expect(productSearchUrl(' gale m ')).toBe('/api/products?search=gale%20m&limit=20')
  })

  it('the answer as picker rows: the SKU, the name under it, the photo; malformed rows and repeats dropped', () => {
    expect(productChoices({ products: [
      { id: 'p1', sku: 'GALE-M', name: 'Gale jacket M', imageUrl: 'https://x/1.jpg' },
      { id: 'p1', sku: 'GALE-M' },
      { id: 'p2', sku: '', name: '' },
      { sku: 'NO-ID' },
      'x',
    ] })).toEqual([
      { value: 'p1', label: 'GALE-M', detail: 'Gale jacket M', image: 'https://x/1.jpg' },
      { value: 'p2', label: 'p2', detail: undefined, image: null },
    ])
    expect(productChoices(null)).toEqual([])
  })
})

describe('the page is reachable and keeps the design-system rules', () => {
  it('the menu: Fulfillment › Outbound › FBA shipments', () => {
    const nav = buildAppNav({} as never, { amazon: true, ebay: true })
    const outbound = nav.find((i) => i.href === '/fulfillment/outbound') as { children?: Array<{ href: string; label: string }> } | undefined
    expect(outbound?.children?.some((c) => c.href === '/fulfillment/outbound/fba' && c.label === 'FBA shipments')).toBe(true)
  })

  it('no raw controls and no Tailwind in the page\'s files', () => {
    for (const file of ['FbaShipmentsClient.tsx', 'FbaShipmentPanel.tsx', 'FbaDraftEditor.tsx']) {
      const source = readFileSync(join(__dirname, file), 'utf8')
      expect(source).not.toMatch(/<(button|input|select|textarea|table)[\s>]/)
      expect(source).not.toMatch(/className="[^"]*\b(text|bg|flex|grid|p|m|px|py|gap)-[a-z0-9]/)
    }
  })
})
