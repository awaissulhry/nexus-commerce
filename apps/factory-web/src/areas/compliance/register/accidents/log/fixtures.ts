import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import { AS_OF, canOf, LOG, LOG_TILES, PREFIX, TODAY } from '../demo/fixtures'
import type { LogAddress } from '../model'
import { AccidentLogView, type AccidentLogModel } from './view/AccidentLogView'

/**
 * SCR-422 (B-W2b-357; design compliance.register page.h "Accident log (W2b)", SAL-423) — the accident log: the entries with the
 * one to tell the authority first, each tile pressed, a filter as chips, the selection with Copy and Export, a row's ⋯, the
 * keys panel, live updates, quality, read-only, no permission, loading, error, empty and filtered empty. Made-up data only.
 */

const ALL: LogAddress = { from: null, to: null, outcome: null, told: null, toTell: false }
const base = (over: Partial<AccidentLogModel> = {}): AccidentLogModel => ({
  prefix: PREFIX,
  can: canOf('inspector'),
  address: ALL,
  rows: { items: LOG, problem: null },
  tiles: LOG_TILES,
  asOf: AS_OF,
  live: 'live',
  updates: 0,
  today: TODAY,
  ...over,
})

export const designScreen = defineDesignScreen<AccidentLogModel>({
  screen: 'SCR-422',
  title: 'Compliance › Accident log (product-safety reports, GPSR art. 20)',
  view: AccidentLogView,
  cases: [
    { id: 'normal', label: 'The log: the accident to tell the authority first', model: base(), note: 'One line per accident (its newest revision); serious harm not told is first and red; the Q37 sentence at rest.' },
    { id: 'tile-to-tell', label: 'Tile pressed: to tell the authority', model: base({ address: { ...ALL, toTell: true, told: 'no' }, rows: { items: LOG.filter((entry) => entry.mustTell), problem: null } }) },
    { id: 'tile-told', label: 'Tile pressed: told', model: base({ address: { ...ALL, told: 'yes' }, rows: { items: LOG.filter((entry) => entry.authority), problem: null } }) },
    { id: 'filters', label: 'What came of it and the period as chips', model: base({ address: { ...ALL, outcome: 'MINOR_HARM', from: '2026-01-01' }, rows: { items: LOG.filter((entry) => entry.outcome === 'MINOR_HARM'), problem: null } }) },
    { id: 'selection', label: 'Two rows selected: Copy 2 numbers, Export 2', model: base({ selected: [LOG[0]!.reportId, LOG[1]!.reportId] }) },
    { id: 'updates', label: 'Changes arrived: 2 updates · Show', model: base({ updates: 2 }) },
    { id: 'keys', label: 'The keys panel (footer icon)', model: base({ keysOpen: true }) },
    { id: 'read-only', label: 'Read-only: a row’s Record a revision held with why', model: base({ can: canOf('readOnly') }), note: 'Open a row’s ⋯: Record a revision and The authority was told say who may.' },
    { id: 'no-permission', label: 'No permission (warehouse): who grants it', model: base({ can: canOf('warehouse') }) },
    { id: 'loading', label: 'Loading', model: base({ rows: { items: null, problem: null }, tiles: null, asOf: null, live: 'connecting' }) },
    { id: 'error', label: 'The read failed: in words, with Try again', model: base({ rows: { items: null, problem: 'read.failed' }, tiles: null }) },
    { id: 'empty', label: 'Empty: no accident recorded', model: base({ rows: { items: [], problem: null }, tiles: { entries: 0, toTell: 0, told: 0 } }) },
    { id: 'filtered-empty', label: 'Filtered, nothing matches: Clear all', model: base({ address: { ...ALL, outcome: 'DEATH' }, rows: { items: [], problem: null } }) },
    { id: 'offline', label: 'Offline: the last copy with its time', model: base({ live: 'offline' }) },
  ],
})
