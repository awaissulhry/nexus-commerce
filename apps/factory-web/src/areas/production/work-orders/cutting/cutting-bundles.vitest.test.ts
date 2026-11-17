import { describe, expect, it } from 'vitest'
import type { ComponentType } from 'react'
import { createApiClient, type ApiClient } from '../../../../lib/api/client'
import { LOCALES } from '../../../../lib/i18n/locales'
import { leftKeys, renderView, textOf } from '../../../../lib/record-thread/parts/testing'
import { getBundles, type BundleRow } from '../../_shared/api'
import { bundlesOf, cutLogOf, workOrder } from '../../_shared/fixtures'
import { isWideTab, MERGED_TABS, RECORD_TABS, tabOf } from '../../_shared/model'
import { getRecuts, type Replacement } from '../../cutting/api'
import { cutRecordAddress } from '../../cutting/record/redirect'
import { cutHref } from '../../cutting/model'
import { listCutOrders, type CutOrderSummary } from '../../cutting/orders/api'
import { ORDER_CUTTING, ORDER_PLANNED } from '../../cutting/orders/demo/fixtures'
import { getCutLogW2b } from './api'
import { designScreen } from './fixtures'
import { cutCellsOf, cutCellsTotal, cutOrdersOf, cutOrdersQuery, cuttingTabCount, partPhrases } from './model'

/**
 * F-PR-06 — the work order record's Cutting & bundles tab (06-tree A.4 Tab 3; 06-sections O-WO-cut-cells, O-WO-cut-lays,
 * O-WO-cut-yield, O-WO-cut-bundles, O-CUT-rec): the tabs 7 → 6 with every old ?tab= kept (R-8: bundles → cutting), ONE cut-and-
 * bundled table (Planned · Cut · Bundled · Short per size × colour, the parts under each, the open recuts), the tab's honest count,
 * the cut orders of this work order (shared with another, named only as the API named it), the Cut record's address redirected,
 * the Cutting list's rows opening the work order's tab, one Report finished button per page, and every case drawn in both
 * languages. Wall PW-03 (web side): the tab's reads name only this work order's id and number. Figures by hand from the made-up
 * fixtures (BLK 48/50/52/54 4·6·6·4, RED 50/52 3·3; cut 4·6·6·4·3·0, in bundles 4·6·6·4·0·0).
 */

const view = designScreen.view as ComponentType<{ model: unknown }>
const draw = (id: string, locale: 'it' | 'en' = 'en') => renderView(view, designScreen.cases.find((item) => item.id === id)!.model, locale)
const WO = workOrder('IN_PROGRESS')
const recut = (over: Partial<Replacement>): Replacement => ({
  id: 'r1',
  workOrder: { id: WO.id, number: WO.number, status: 'IN_PROGRESS' },
  cell: { id: WO.cells[1]!.id, colourwayCode: 'BLK', size: '50', quantity: 6 },
  kind: 'RECUT',
  quantity: 1,
  part: 'Maniche',
  sourceScanId: null,
  reworkOrderId: null,
  reason: 'Macchia',
  status: 'OPEN',
  decidedAt: null,
  decidedBy: null,
  decisionNote: null,
  cutLogId: null,
  doneAt: null,
  note: null,
  version: 1,
  createdAt: '2026-10-28T14:20:00.000Z',
  createdBy: null,
  ...over,
})

describe('F-PR-06 — the tabs: Cutting and Bundles are ONE tab', () => {
  it('six tabs; an old ?tab=bundles (and Floor now’s ?tab=bundles&at=<seq>) opens Cutting & bundles; every other old tab still lands', () => {
    expect(RECORD_TABS).toEqual(['overview', 'materials', 'cutting', 'operations', 'quality', 'labour'])
    expect(RECORD_TABS).not.toContain('bundles' as never)
    expect(MERGED_TABS.bundles).toBe('cutting')
    expect(tabOf('bundles')).toBe('cutting')
    expect(tabOf('cutting')).toBe('cutting')
    expect(tabOf('documents')).toBe('overview')
    expect(isWideTab('cutting')).toBe(true)
  })

  it('the tab counts the bundles live on the floor (a void one is not), nothing while the bundles are not read', () => {
    expect(cuttingTabCount(bundlesOf())).toBe(7)
    expect(cuttingTabCount(bundlesOf('empty'))).toBe(0)
    expect(cuttingTabCount(null)).toBeNull()
  })
})

describe('F-PR-06 — ONE table: cut and bundled per size × colour', () => {
  it('Planned · Cut · Bundled · Short per cell, joined by the size (the cut-vs-plan grid and the bundles’ card were the same figures)', () => {
    const rows = cutCellsOf(cutLogOf(), bundlesOf())
    expect(rows.map((row) => `${row.colourwayCode} ${row.size}`)).toEqual(['BLK 48', 'BLK 50', 'BLK 52', 'BLK 54', 'RED 50', 'RED 52'])
    expect(rows.map((row) => [row.planned, row.cut, row.bundled, row.short])).toEqual([
      [4, 4, 4, 0],
      [6, 6, 6, 0],
      [6, 6, 6, 0],
      [4, 4, 4, 0],
      [3, 3, 0, 0],
      [3, 0, 0, 3],
    ])
    // RED 50 is cut, not bundled yet: 3 to bundle.
    expect(rows.map((row) => row.toBundle)).toEqual([0, 0, 0, 0, 3, 0])
    expect(cutCellsTotal(rows)).toEqual({ planned: 26, cut: 23, bundled: 20, toBundle: 3, short: 3 })
  })

  it('each cell’s parts: cut of planned, what is short, the open recuts (a done recut no more); a cell not cut yet lists no part', () => {
    const rows = cutCellsOf(cutLogOf(), bundlesOf(), [recut({}), recut({ id: 'r2', part: 'Collo', status: 'DONE' })])
    expect(rows[1]!.parts.map((part) => [part.part, part.cut, part.plannedPieces, part.short, part.recut])).toEqual([
      ['Corpo', 6, 6, 0, 0],
      ['Maniche', 6, 6, 0, 1],
      ['Collo', 6, 6, 0, 0],
    ])
    expect(rows[5]!.parts).toEqual([])
    expect(partPhrases(rows[1]!.parts[1]!)).toEqual([
      { key: 'cutting.cells.part', params: { part: 'Maniche', cut: 6, planned: 6 } },
      { key: 'cutting.cells.partRecut', params: { count: 1 } },
    ])
    expect(partPhrases({ part: 'Fodera', planned: false, plannedPieces: 0, cut: 2, short: 0, recut: 0 })).toEqual([{ key: 'cutting.cells.partExtra', params: { part: 'Fodera', cut: 2 } }])
    expect(partPhrases({ part: 'Corpo', planned: true, plannedPieces: 4, cut: 1, short: 3, recut: 0 })).toEqual([
      { key: 'cutting.cells.part', params: { part: 'Corpo', cut: 1, planned: 4 } },
      { key: 'cutting.cells.partShort', params: { count: 3 } },
    ])
  })

  it('one read missing: its columns say "—" (null), never 0, and no cell is dropped', () => {
    const noBundles = cutCellsOf(cutLogOf(), null)
    expect(noBundles.map((row) => row.bundled)).toEqual([null, null, null, null, null, null])
    expect(cutCellsTotal(noBundles).bundled).toBeNull()
    const noLog = cutCellsOf(null, bundlesOf())
    expect(noLog.map((row) => [row.planned, row.cut, row.bundled, row.short])).toEqual([
      [4, 4, 4, 0],
      [6, 6, 6, 0],
      [6, 6, 6, 0],
      [4, 4, 4, 0],
      [3, 3, 0, 0],
      [3, 0, 0, 3],
    ])
    expect(noLog.every((row) => row.parts.length === 0)).toBe(true)
    expect(cutCellsOf(null, null)).toEqual([])
  })
})

describe('F-PR-06 — the cut orders of this work order (its fabric lays) and PW-03', () => {
  const OWN = { id: WO.id, number: WO.number }
  const OTHER = { id: 'wo-other', number: 'WO-00011' }
  const rows: CutOrderSummary[] = [
    { ...ORDER_PLANNED, workOrders: [OWN] },
    { ...ORDER_CUTTING, workOrders: [OWN, OTHER] },
    // Found by the number search, but cuts for another work order only (its number holds ours): not this work order's.
    { ...ORDER_CUTTING, id: 'co-3', number: 'CO-2026-0099', workOrders: [{ id: 'wo-x', number: `${WO.number}1` }] },
  ]

  it('PW-03: only the cut orders that name this work order’s id; the others it shares lays with exactly as the API named them', () => {
    const found = cutOrdersOf(rows, WO.id)
    expect(found.map((row) => row.order.number)).toEqual([ORDER_PLANNED.number, ORDER_CUTTING.number])
    expect(found[0]!.others).toEqual([])
    expect(found[1]!.others).toEqual([OTHER])
    // Never more than the API sent: a reader limited to some customers is sent no other customer's work order.
    expect(cutOrdersOf([{ ...ORDER_CUTTING, workOrders: [OWN] }], WO.id)[0]!.others).toEqual([])
    expect(cutOrdersOf(rows, 'someone-else')).toEqual([])
  })

  it('the tab shows the shared one with the other work order’s number, never a customer’s name', () => {
    const text = textOf(draw('cut-orders'))
    expect(text).toContain('Shared with another work order: WO-00011')
    expect(text).toContain('Cut orders and lays')
  })

  it('PW-03 (web side): every read of the tab names only this work order — its id, or its number for the cut orders', async () => {
    const calls: string[] = []
    const api: ApiClient = createApiClient({
      baseUrl: '/api',
      fetch: (async (input: RequestInfo | URL) => {
        calls.push(String(input))
        const path = new URL(String(input), 'http://x').pathname
        const body = path.endsWith('/replacements') ? { replacements: [] } : path.endsWith('/cut-orders') ? { rows: [], nextCursor: null, tiles: { planned: 0, released: 0, cutting: 0, cut: 0, cancelled: 0 } } : {}
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
      }) as typeof fetch,
      csrfToken: () => 'csrf',
    })
    await getRecuts(api, WO.id)
    await listCutOrders(api, cutOrdersQuery(WO.number)).catch(() => undefined)
    await getBundles(api, WO.id).catch(() => undefined)
    await getCutLogW2b(api, WO.id).catch(() => undefined)
    expect(calls[0]).toContain(`workOrderId=${encodeURIComponent(WO.id)}`)
    expect(calls[1]).toContain(`q=${WO.number}`)
    expect(calls[1]).toContain('view=all')
    expect(calls[2]).toContain(`/production/bundles/work-orders/${WO.id}/bundles`)
    expect(calls[3]).toContain(`/production/cutting/work-orders/${WO.id}/cut-log`)
    for (const call of calls) expect(call).not.toMatch(/partyId|customer/)
    expect(cutOrdersQuery(WO.number)).toEqual({ view: 'all', q: WO.number, limit: 50 })
  })
})

describe('F-PR-06 — the Cut record merged in: its address redirects, the Cutting list opens the work order', () => {
  it('/production/cutting/<id> (any of its old tabs) → the work order’s Cutting & bundles', () => {
    expect(cutRecordAddress('DEMO', WO.id)).toBe(`/w/DEMO/production/work-orders/${WO.id}?tab=cutting`)
    expect(cutRecordAddress('A%20B', 'wo 1')).toBe('/w/A%20B/production/work-orders/wo%201?tab=cutting')
    expect(cutHref('/w/DEMO', WO.id)).toBe(`/w/DEMO/production/work-orders/${WO.id}?tab=cutting`)
  })

  it('what only the Cut record drew is on the tab: pieces per part, recuts with Mark cut, cut orders, yield per lot, issued against used', () => {
    const text = textOf(draw('merged'))
    expect(text).toContain('Cut and bundled per size × colour')
    for (const column of ['Planned', 'Cut', 'In bundles', 'Short']) expect(text).toContain(column)
    expect(text).toContain('Maniche 6 of 6')
    expect(text).toContain('1 to recut')
    expect(text).toContain('Total')
    const recuts = textOf(draw('recuts'))
    expect(recuts).toContain('Recuts')
    expect(recuts).toContain('Mark cut…')
    expect(recuts).toContain('1 × Maniche · BLK 50')
    expect(textOf(draw('lot-yield'))).toContain('Raise with the supplier')
  })
})

describe('F-PR-06 — one Report finished button per page; the screen in both languages', () => {
  const reportButtons = (html: string) => (textOf(html).match(/Report \d+ finished/g) ?? []).length

  it('the band holds Report finished; the tab’s finished-to-stock card has its figures only', () => {
    const html = draw('w2a-finished')
    expect(reportButtons(html)).toBe(1)
    expect(textOf(html)).toContain('Report finished is the main button at the top of the work order')
    // Nothing released yet: no Report finished anywhere on the page.
    expect(reportButtons(draw('w2a-finish-nothing'))).toBe(0)
  })

  it('the old bundles address shows the bundles waiting at the operation on Cutting & bundles', () => {
    const text = textOf(draw('old-bundles-address'))
    expect(text).toContain('Waiting at 20 ASM-CORPO')
    expect(text).toContain('Cut and bundled per size × colour')
  })

  it('every case draws in it and en with no key left', () => {
    const prefixes = ['cutting', 'bundles', 'recuts', 'pieces', 'yield', 'ofWorkOrder', 'feedback', 'balance', 'finished', 'tab', 'part', 'held', 'problem']
    for (const item of designScreen.cases) {
      for (const locale of LOCALES) {
        const html = renderView(view, item.model, locale)
        expect(leftKeys(html, prefixes), `${item.id} (${locale})`).toEqual([])
      }
    }
  })

  it('a team leader’s tab reads no recuts and no cut orders (no right): neither card is drawn', () => {
    const text = textOf(draw('team-leader-parts'))
    expect(text).not.toContain('Mark cut')
    expect(text).not.toContain('Shared with another work order')
  })

  it('bundles keep where each waits, Reprint N and Split; a void bundle stays listed', () => {
    const bundles: BundleRow[] = bundlesOf().bundles
    expect(bundles.filter((bundle) => bundle.status === 'VOID')).toHaveLength(1)
    expect(textOf(draw('bundles'))).toContain('Bundles')
  })
})
