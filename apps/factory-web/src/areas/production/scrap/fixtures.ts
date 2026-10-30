import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { addressOf } from './model'
import { canAs, inShell, ME, REDUCTIONS, ROWS, TILES, TODAY_START, type Role } from './demo/fixtures'
import { ScrapView, type ScrapModel } from './view/ScrapView'

/**
 * SCR-140 — Production › Floor control › Scrap & rework (design production.scrap; MES-129, MES-130), with made-up data
 * only: the tiles (each a saved filter; second quality is W2b), the pareto by reason, operation or style (a bar filters
 * the list), every scrap and rework row with its leather per lot and hide and what replaces it, a selection (Approve N
 * reaches only what this person may decide), the row's detail (approve, refuse with why; never one's own request) and
 * Replace scrapped quantity (recut or lower quantity, held with why), and the states. Roles: production manager,
 * planner (decides), quality inspector (reads), finance (values), owner, sales (none).
 */

interface ScrapCase {
  role: Role
  model: ScrapModel
}

const page = (role: Role, over: Partial<ScrapModel> = {}, query = ''): ScrapCase => ({
  role,
  model: {
    prefix: '/w/DEMO',
    can: canAs(role),
    me: ME,
    address: addressOf(new URLSearchParams(query)),
    timeZone: 'Europe/Rome',
    todayStart: TODAY_START,
    rows: { items: ROWS, problem: null },
    tiles: TILES,
    reductions: REDUCTIONS,
    asOf: '2026-10-30T09:30:00.000Z',
    live: 'live',
    updates: 0,
    slow: false,
    shown: 50,
    chartOpen: true,
    busy: false,
    problem: null,
    notice: null,
    replace: null,
    ...over,
  },
})

function ScrapDesign({ model }: { model: ScrapCase }) {
  return inShell('/production/scrap', createElement(ScrapView, { model: model.model }), model.role)
}

const row = (index: number) => ROWS[index]!

export const designScreen = defineDesignScreen<ScrapCase>({
  screen: 'SCR-140',
  title: 'Scrap & rework (Production)',
  view: ScrapDesign,
  cases: [
    { id: 'all', label: 'Production manager: tiles, pareto by reason, every row', model: page('manager'), note: 'A tile is a saved filter; a bar filters the list; a row opens its detail (A / R, J / K).' },
    { id: 'by-operation', label: 'Pareto by operation', model: page('manager', {}, 'by=operation') },
    { id: 'by-style', label: 'Pareto by style', model: page('manager', {}, 'by=style') },
    { id: 'bar', label: 'A bar pressed: only “Stain” rows', model: page('manager', {}, 'group=STAIN') },
    { id: 'approve-view', label: 'Tile Waiting for approval pressed', model: page('planner', {}, 'view=approve') },
    { id: 'selected', label: 'Planner: two rows selected — Approve 1 (his own is not reached)', model: page('planner', { me: REDUCTIONS[0]!.createdBy!.id, selected: [row(1).id, row(2).id] }) },
    { id: 'selected-none', label: 'Selected rows with nothing to approve — Approve held with why', model: page('planner', { selected: [row(0).id, row(3).id] }) },
    { id: 'item', label: 'Detail: scrap 2 pieces · WO-26-0031 (leather per lot and hide; Replace)', model: page('manager', {}, `open=${row(0).id}`) },
    { id: 'item-approve', label: 'Detail: a lower quantity to decide (A approve, R refuse)', model: page('planner', {}, `open=${row(2).id}`) },
    { id: 'item-own', label: 'Detail: my own request — held, another person decides', model: page('manager', {}, `open=${row(1).id}`) },
    { id: 'item-refuse', label: 'Detail: refusing — the note says why', model: page('planner', { refusing: true }, `open=${row(2).id}`) },
    { id: 'item-rework', label: 'Detail: a rework in progress', model: page('manager', {}, `open=${row(5).id}`) },
    { id: 'item-cost', label: 'Finance: the value with the cost grain', model: page('finance', {}, `open=${row(0).id}`) },
    { id: 'replace', label: 'Replace scrapped quantity: a recut', model: page('manager', { replace: { rowId: row(0).id, draft: { kind: 'RECUT', quantity: '1', reason: 'Front panel stained beyond cleaning' } } }, `replace=${row(0).id}`) },
    { id: 'replace-reduce', label: 'Replace: lower the order quantity (needs approval)', model: page('manager', { replace: { rowId: row(2).id, draft: { kind: 'REDUCE', quantity: '1', reason: '' } } }, `replace=${row(2).id}`) },
    { id: 'replace-held', label: 'Replace: a completed work order — held with why', model: page('manager', { replace: { rowId: row(4).id, draft: { kind: 'RECUT', quantity: '1', reason: 'Late stain' } } }, `replace=${row(4).id}`) },
    { id: 'replace-refused', label: 'Replace: refused by the API, in words', model: page('manager', { replace: { rowId: row(0).id, draft: { kind: 'RECUT', quantity: '1', reason: 'Front panel stained' } }, problem: { key: 'problem.moreThanScrapped' } }, `replace=${row(0).id}`) },
    { id: 'notice', label: 'After a recut was asked: the notice', model: page('manager', { notice: { tone: 'success', words: { key: 'notice.asked.RECUT', params: { count: 1, number: 'WO-26-0031' } } } }) },
    { id: 'cost', label: 'Finance: the value column (cost grain)', model: page('finance') },
    { id: 'inspector', label: 'Quality inspector: reads; Replace and Approve held', model: page('inspector') },
    { id: 'owner', label: 'Owner', model: page('owner') },
    { id: 'chart-off', label: 'Pareto hidden', model: page('manager', { chartOpen: false }) },
    { id: 'updates', label: 'Live: 2 updates behind Show', model: page('manager', { updates: 2 }) },
    { id: 'offline', label: 'Offline', model: page('manager', { live: 'offline' }) },
    { id: 'loading', label: 'Loading', model: page('manager', { rows: { items: null, problem: null }, tiles: null, asOf: null, live: 'connecting' }) },
    { id: 'slow', label: 'Still loading after a second', model: page('manager', { rows: { items: null, problem: null }, tiles: null, asOf: null, slow: true }) },
    { id: 'error', label: 'The read failed: in words, with Try again', model: page('manager', { rows: { items: null, problem: 'problem.offline' }, tiles: null, live: 'offline' }) },
    { id: 'empty', label: 'No scrap yet', model: page('manager', { rows: { items: [], problem: null }, tiles: { scrapToday: 0, reworkOpen: 0, recutsToCut: 0, reductionsToApprove: 0 } }) },
    { id: 'empty-filters', label: 'No rows match these filters', model: page('manager', {}, 'q=ZZZ') },
    { id: 'no-permission', label: 'Sales: no production.scrap.view', model: page('sales') },
  ],
})
