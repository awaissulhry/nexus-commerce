import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { WaitingModel, WaitingRow } from './model'
import { WaitingOnView } from './view/WaitingOnView'

/**
 * SCR-540 — Today › Waiting on others (B-W2b-388; design home.today `waiting-on`). Made-up data only: every name, number and
 * company is invented.
 */

const NOW = Date.UTC(2026, 10, 13, 9, 30)
const AS_OF = new Date(NOW - 60_000).toISOString()
const id = (n: number) => `0190f0e2-7777-7000-8000-${String(n).padStart(12, '0')}`
const day = (offset: number) => new Date(NOW - offset * 86_400_000).toISOString()

function row(n: number, extra: Pick<WaitingRow, 'kind' | 'record' | 'waitingFor' | 'ageDays'> & Partial<WaitingRow>): WaitingRow {
  return {
    key: `${extra.kind}:${extra.record.id}`,
    companyId: id(900),
    siteId: null,
    partyId: id(800 + n),
    sentence: 'English sentence of the API (not shown).',
    since: day(extra.ageDays),
    due: null,
    nudge: { allowed: false, refusal: 'OUTSIDE' },
    href: `/w/DEMO/records/${extra.record.type}/${extra.record.id}`,
    ...extra,
  }
}

const ROWS: WaitingRow[] = [
  row(1, { kind: 'APPROVAL_REQUEST', record: { type: 'Quote', id: id(1), label: 'Q-2026-0142' }, waitingFor: 'An approver of quotes', ageDays: 2, due: '2026-11-20', nudge: { allowed: true, refusal: null } }),
  row(2, { kind: 'PO_CONFIRMATION', record: { type: 'PurchaseOrder', id: id(2), label: 'PO-2026-0031' }, waitingFor: 'Conceria Demo Srl', ageDays: 4, due: '2026-11-18' }),
  row(3, { kind: 'QUOTE_ANSWER', record: { type: 'Quote', id: id(3), label: 'Q-2026-0139' }, waitingFor: 'Moto Demo Club', ageDays: 6 }),
  row(4, { kind: 'MESSAGE_REPLY', record: { type: 'SalesOrder', id: id(4), label: 'SO-2026-0047' }, waitingFor: 'Pista Esempio Racing', ageDays: 5 }),
  row(5, { kind: 'LINK_UNOPENED', record: { type: 'PurchaseOrder', id: id(5), label: 'PO-2026-0036' }, waitingFor: 'Fodere Prova Spa', ageDays: 1, due: '2026-11-27' }),
]

const ready = (items: readonly WaitingRow[]): WaitingModel['rows'] => ({ status: 'ready', data: { items, asOf: AS_OF } })
const base: WaitingModel = { rows: ready(ROWS), now: NOW, held: null, notice: null }

export const designScreen = defineDesignScreen<WaitingModel>({
  screen: 'SCR-540',
  title: 'Today › Waiting on others (B-W2b-388)',
  view: WaitingOnView,
  cases: [
    { id: 'normal', label: 'Five kinds of waits', model: base, note: 'An approval I asked for (Nudge), a PO and a quote not answered, a mail with no reply in 3 working days, a link nobody opened; each says whom I wait for and since when, the record as a link.' },
    {
      id: 'nudged',
      label: 'Nudged today already',
      model: { ...base, rows: ready(ROWS.map((entry) => (entry.kind === 'APPROVAL_REQUEST' ? { ...entry, nudge: { allowed: false, refusal: 'TODAY_ALREADY' as const } } : entry))), notice: { key: 'waiting.nudge.done', tone: 'success', params: { record: 'Q-2026-0142', count: 2 } } },
      note: 'Nudge held with its reason (once a business day); the notice says how many people who may decide were reminded.',
    },
    { id: 'offline', label: 'Offline', model: { ...base, held: 'held.offline' }, note: 'Rows stay readable; Nudge is held "Offline — do this when you are back online."' },
    { id: 'empty', label: 'Not waiting on anyone', model: { ...base, rows: ready([]) }, note: '"You are not waiting on anyone."' },
    { id: 'loading', label: 'Loading', model: { ...base, rows: { status: 'loading' } }, note: 'Skeleton with "Still loading…".' },
    { id: 'error', label: 'Could not load', model: { ...base, rows: { status: 'error', problem: 'waiting.problem.read' } }, note: 'The problem in words and Try again; other sections keep working.' },
  ],
})
