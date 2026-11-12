import { defineDesignScreen } from '../../../lib/design/design-screen'
import type { HistoryLine } from './api'
import type { ApprovalHistoryModel } from './model'
import { ApprovalHistory } from './view/ApprovalHistory'

/**
 * SCR-352 — Approvals: the history on a record (B-W2b-307; PLT-104) — made-up data only (PLAN §3.1): a made-up purchase
 * order asked, found changed, asked again and signed; a made-up quote approved by the reader; a no with its reason; the
 * empty, loading, error, no-permission and "show more" states. The record panels' Approvals tab and the inbox review's
 * History tab draw this one part.
 */

const at = (day: number, hour: number, minute = 0) => new Date(Date.UTC(2026, 10, day, hour, minute)).toISOString()
const person = (id: string, name: string, me = false) => ({ kind: 'PERSON' as const, id, name, me })
const SYSTEM = { kind: 'SYSTEM' as const, id: null, name: 'Sistema', me: false }
const FIONA = person('0190f0e2-3070-7000-8000-000000000001', 'Fiona Demo')
const BRUNO = person('0190f0e2-3070-7000-8000-000000000002', 'Bruno Esempio')
const ME = person('0190f0e2-3070-7000-8000-000000000003', 'Olga Prova', true)

const line = (id: number, extra: Partial<HistoryLine> & Pick<HistoryLine, 'action' | 'at' | 'by'>): HistoryLine => ({
  id: `0190f0e2-3070-7000-8000-1000000000${String(id).padStart(2, '0')}`,
  source: 'ApprovalEvent',
  words: null,
  reasonCode: null,
  meaning: null,
  taskId: '0190f0e2-3070-7000-8000-200000000001',
  ...extra,
})

const PO_LINES: HistoryLine[] = [
  line(6, { action: 'SIGNED', at: at(11, 10, 42), by: FIONA, meaning: 'RELEASED' }),
  line(5, { action: 'APPROVED', at: at(11, 10, 42), by: FIONA, meaning: 'RELEASED', words: 'Ok, the supplier confirmed the dates.' }),
  line(4, { action: 'REQUESTED', at: at(11, 9, 15), by: BRUNO, words: 'Lines updated after the call.' }),
  line(3, { action: 'STALE', at: at(10, 16, 2), by: SYSTEM }),
  line(2, { action: 'REQUESTED', at: at(10, 11, 30), by: BRUNO }),
]

const model = (overrides: Partial<ApprovalHistoryModel> = {}): ApprovalHistoryModel => ({
  allowed: true,
  now: Date.parse(at(11, 11)),
  read: { status: 'ready', lines: PO_LINES, more: false },
  ...overrides,
})

export const designScreen = defineDesignScreen<ApprovalHistoryModel>({
  screen: 'SCR-352',
  title: 'Approvals: the history on a record (record panels · review History)',
  view: ApprovalHistory,
  cases: [
    { id: 'w2b-307-signed', label: 'A purchase order asked, changed, asked again and signed', model: model(), note: 'Newest first: signed "Released", approved with a comment, asked again, the system found it changed, the first ask.' },
    {
      id: 'w2b-307-mine-and-no',
      label: 'My yes, and a no with its reason',
      model: model({
        read: {
          status: 'ready',
          more: false,
          lines: [
            line(9, { action: 'APPROVED', at: at(9, 15, 5), by: ME, source: 'QuoteApproval', taskId: null, words: 'Primo ordine del cliente.' }),
            line(8, { action: 'REJECTED', at: at(8, 12, 40), by: FIONA, reasonCode: 'OVER_BUDGET', words: 'Over the monthly budget for leather.' }),
            line(7, { action: 'WITHDRAWN', at: at(8, 9, 0), by: BRUNO }),
            line(1, { action: 'COMMENTED', at: at(7, 17, 20), by: BRUNO, taskId: null, words: 'Waiting for the new sample first.' }),
          ],
        },
      }),
    },
    { id: 'w2b-307-more', label: 'A long history: Show more', model: model({ read: { status: 'ready', lines: PO_LINES, more: true } }) },
    { id: 'w2b-307-empty', label: 'No approval yet', model: model({ read: { status: 'ready', lines: [], more: false } }) },
    { id: 'w2b-307-loading', label: 'Loading', model: model({ read: { status: 'loading' } }) },
    { id: 'w2b-307-error', label: 'Error (Try again)', model: model({ read: { status: 'error', problem: 'unavailable' } }) },
    { id: 'w2b-307-refused', label: 'The record is outside my rights', model: model({ read: { status: 'error', problem: 'forbidden' } }) },
    { id: 'w2b-307-no-permission', label: 'No approvals.view: the section is absent', model: model({ allowed: false }), note: 'Nothing is drawn (never a locked box).' },
  ],
})
