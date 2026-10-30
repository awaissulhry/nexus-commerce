import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { canFor, inShell, NOW, PREFIX, SITE, SITE_SOUTH, TIME_ZONE, type RoleCase } from '../../../_shared/stock/fixtures'
import { CHECKLIST_OPEN, LOT_COUNTS, LOT_ROWS } from '../demo/fixtures'
import { dailyFor } from '../demo/daily/fixtures'
import { FIND_SEVERAL } from '../demo/trace/fixtures'
import type { ReleaseDialogModel, ReleaseLine } from '../release/model'
import { blankFind } from '../trace/model'
import { defaultLotView, type LotsListModel, type LotView } from '../model'
import { LotsListView } from './view/LotsListView'

/**
 * SCR-201 — Lots & traceability (Warehouse › Main) with made-up data only: released, quarantined, Cr VI failed (blocked),
 * lining and protector lots, opening stock and a rejected lot; the tiles as saved views (holds reached here, Q3), the
 * search, the selection's Export, and the page's states. B-W2a-64: Release N lots (the review of which can go and which
 * cannot with reasons, the typed phrase, each lot's outcome) and the Trace dialog (one field; several matches; nothing
 * found; a label the trace does not take; a failed read). Roles: Owner, Warehouse (Release held: no right), Quality
 * (waits for release by default, releases), Read-only, Sales and Admin (no inventory.stock.view: the page says which
 * permission is missing).
 */

interface LotsCase {
  role: RoleCase
  list: LotsListModel
}

function listCase(role: RoleCase, over: Partial<LotsListModel> = {}, view?: LotView): LotsCase {
  const can = canFor(role)
  return {
    role,
    list: {
      prefix: PREFIX,
      can,
      view: view ?? defaultLotView(can),
      q: '',
      sites: [SITE, SITE_SOUTH],
      siteId: null,
      rows: { items: LOT_ROWS, more: false, problem: null },
      counts: LOT_COUNTS,
      asOf: NOW,
      live: 'live',
      updates: 0,
      timeZone: TIME_ZONE,
      daily: dailyFor(role),
      release: null,
      find: null,
      ...over,
    },
  }
}

const [released, quarantine, failed, , protector] = LOT_ROWS
const ready = (row: typeof quarantine, version = 3): ReleaseLine => ({ id: row!.id, code: row!.code, status: row!.qualityStatus, check: { state: 'ready', ready: true, mode: 'RELEASE', version, status: row!.qualityStatus, open: [] }, result: null })
const REVIEW: ReleaseLine[] = [
  ready({ ...protector!, qualityStatus: 'QUARANTINE' }),
  { id: quarantine!.id, code: quarantine!.code, status: 'QUARANTINE', check: { state: 'ready', ready: false, mode: 'RELEASE', version: 2, status: 'QUARANTINE', open: CHECKLIST_OPEN.checks.filter((check) => check.state === 'OPEN') }, result: null },
  { id: failed!.id, code: failed!.code, status: 'BLOCKED', check: { state: 'ready', ready: false, mode: 'UNBLOCK', version: 4, status: 'BLOCKED', open: [] }, result: null },
  { id: released!.id, code: released!.code, status: 'RELEASED', check: { state: 'ready', ready: false, mode: 'RELEASE', version: 5, status: 'RELEASED', open: [] }, result: null },
]
const review = (over: Partial<ReleaseDialogModel> = {}): ReleaseDialogModel => ({ lines: REVIEW, phrase: '', note: '', busy: false, done: false, ...over })

function LotsDesign({ model }: { model: LotsCase }) {
  return inShell('/warehouse/lots', createElement(LotsListView, { model: model.list }), model.role)
}

const held = LOT_ROWS.filter((row) => row.qualityStatus === 'QUARANTINE' || row.qualityStatus === 'BLOCKED')

export const designScreen = defineDesignScreen<LotsCase>({
  screen: 'SCR-201',
  title: 'Lots & traceability (every lot with its tests, documents, stock and holds)',
  view: LotsDesign,
  cases: [
    { id: 'owner', label: 'Owner: every lot, in stock first', model: listCase('owner', {}, 'all'), note: 'Lot code → the lot record; row ⋯ Decide in Tests & substances (the one place lots are released).' },
    { id: 'warehouse', label: 'Warehouse: lots that hold stock', model: listCase('warehouse', { rows: { items: LOT_ROWS.filter((row) => row.onHand !== '0.0000'), more: true, problem: null } }) },
    { id: 'quality', label: 'Quality: waiting for release by default', model: listCase('quality', { rows: { items: held, more: false, problem: null } }) },
    { id: 'tile-cr-vi', label: 'Tile pressed: waiting for Cr VI evidence', model: listCase('quality', { rows: { items: held.filter((row) => row.crVi.status === 'PENDING'), more: false, problem: null } }, 'crViPending') },
    { id: 'tile-failed', label: 'Tile pressed: Cr VI failed (blocked, can never be issued)', model: listCase('owner', { rows: { items: held.filter((row) => row.crVi.status === 'FAIL'), more: false, problem: null } }, 'crViFailed') },
    { id: 'search', label: 'Searched a supplier lot', model: listCase('warehouse', { q: 'CD-26-04', rows: { items: LOT_ROWS.slice(0, 2), more: false, problem: null } }, 'all') },
    { id: 'selected', label: 'Three lots selected: Export 3 (CSV)', model: listCase('owner', { selected: LOT_ROWS.slice(0, 3).map((row) => row.id) }, 'all') },
    { id: 'one-site', label: 'One site only (no site menu), live updates waiting', model: listCase('warehouse', { sites: [SITE], updates: 3 }) },
    { id: 'read-only', label: 'Read-only: sees every lot, exports', model: listCase('readOnly', {}, 'all') },
    { id: 'keys', label: 'The keys (footer icon, ?)', model: listCase('warehouse', { helpOpen: true }) },
    { id: 'loading', label: 'Loading', model: listCase('warehouse', { rows: { items: null, more: false, problem: null }, counts: null, asOf: null }) },
    { id: 'error', label: "The lots couldn't be read", model: listCase('warehouse', { rows: { items: null, more: false, problem: 'problem.offline' }, counts: null }) },
    { id: 'empty', label: 'No lots yet', model: listCase('warehouse', { rows: { items: [], more: false, problem: null }, counts: { quarantine: 0, waitingCrVi: 0, crViFailed: 0, blocked: 0, rejected: 0, released: 0 } }, 'all') },
    { id: 'no-match', label: 'Nothing matches the search', model: listCase('warehouse', { q: 'ZZZ', rows: { items: [], more: false, problem: null } }, 'all') },
    { id: 'release-selected', label: 'B-W2a-64 — Quality: four lots selected, Release 4 lots in the selection row and the band', model: listCase('quality', { selected: REVIEW.map((line) => line.id), rows: { items: LOT_ROWS, more: false, problem: null } }, 'all') },
    { id: 'release-held', label: 'B-W2a-64 — Warehouse: Release held in words (no quality.lots.release)', model: listCase('warehouse', { selected: [quarantine!.id] }, 'all') },
    { id: 'release-checking', label: 'B-W2a-64 — Release: reading each lot’s release check', model: listCase('quality', { release: review({ lines: REVIEW.map((line) => ({ ...line, check: { state: 'loading' } })) }) }, 'all') },
    { id: 'release-review', label: 'B-W2a-64 — Release review: 1 can go, 3 cannot (checks open, blocked: unblock, released already)', model: listCase('quality', { release: review() }, 'all') },
    { id: 'release-phrase', label: 'B-W2a-64 — Release one lot: its code typed (the single release’s legal weight), a note', model: listCase('quality', { release: review({ phrase: protector!.code, note: 'Certificato EN 1621 arrivato' }) }, 'all') },
    {
      id: 'release-several',
      label: 'B-W2a-64 — Release 2 lots: “RELEASE 2” typed',
      model: listCase('quality', { release: review({ lines: [REVIEW[0]!, ready({ ...LOT_ROWS[5]!, qualityStatus: 'QUARANTINE' }, 1)], phrase: 'RILASCIA 2' }) }, 'all'),
    },
    {
      id: 'release-done',
      label: 'B-W2a-64 — Released: one lot usable, one refused (it changed meanwhile)',
      model: listCase('quality', { release: review({ lines: [{ ...REVIEW[0]!, result: { ok: true } }, { ...ready({ ...LOT_ROWS[5]!, qualityStatus: 'QUARANTINE' }, 1), result: { ok: false, key: 'lt.rel.result.changed' } }], done: true }) }, 'all'),
    },
    { id: 'trace-dialog', label: 'B-W2a-64 — Trace…: one field, scan or type any code', model: listCase('warehouse', { find: blankFind() }) },
    { id: 'trace-several', label: 'B-W2a-64 — Trace: the code names two records, pick one', model: listCase('warehouse', { find: { code: FIND_SEVERAL.code, state: 'several', matches: FIND_SEVERAL.matches, problem: null } }) },
    { id: 'trace-none', label: 'B-W2a-64 — Trace: nothing found for the code', model: listCase('warehouse', { find: { code: 'ZZ-0000', state: 'none', matches: [], problem: null } }) },
    { id: 'trace-unreadable', label: 'B-W2a-64 — Trace: a place label (the trace does not take it)', model: listCase('warehouse', { find: { code: 'LOC-DM-12', state: 'unreadable', matches: [], problem: null } }) },
    { id: 'trace-finding', label: 'B-W2a-64 — Trace: looking the code up', model: listCase('warehouse', { find: { code: 'HD-DEMO-0003', state: 'finding', matches: [], problem: null } }) },
    { id: 'trace-error', label: 'B-W2a-64 — Trace: the lookup failed (offline)', model: listCase('warehouse', { find: { code: 'HD-DEMO-0003', state: 'error', matches: [], problem: 'problem.offline' } }) },
    { id: 'sales', label: 'Sales: no inventory.stock.view (the page says so)', model: listCase('sales') },
    { id: 'admin', label: 'Admin: no inventory.stock.view (the page says so)', model: listCase('admin') },
  ],
})
