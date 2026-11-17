import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import type { RecordDockedInput } from '../../../lib/record-thread/fixtures'
import { BRAND_ALPHA } from '../../../lib/testing/two-brands'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { designDockedThread } from '../record-frame/fixtures'
import type { RecordSummary } from './api'
import { parentHrefOf, type Opener } from './model'
import { GenericRecordView, type GenericRecordModel } from './view/GenericRecordView'

/**
 * SCR-006-generic — the generic record page (B-TH-272; PL5; O-REC-ANY.summary, O-REC-ANY.thread; picture 41, never drawn: built to
 * the design kit, the tree and the record-frame pattern). Made-up data only: a delivery note of Brand Alpha's order (the party's own
 * words in the thread, "Reply to Brand Alpha"), a nonconformance with notes only, a request for a yes with no number and no state, and
 * every page state (reading with the opener's label, 404 in neutral words, no right, a problem). The page itself mounts the office's
 * live thread; the design draws the made-up docked thread in its slot.
 */

const PREFIX = '/w/DEMO'
const NO_OPENER: Opener = { label: null, companyId: null, siteId: null }

interface GenericCase {
  readonly model: GenericRecordModel
  /** The made-up thread of the record (its party's own words, or notes only); null: none on this case. */
  readonly thread: RecordDockedInput | null
}

/** The design view: the page with the made-up docked thread in its slot (outside a RecordFrame: no width menu, as live). */
function GenericDesign({ model }: { model: GenericCase }) {
  return createElement(GenericRecordView, { model: model.model, thread: model.thread ? designDockedThread(model.thread) : null })
}

const deliveryNote: RecordSummary = {
  recordType: 'Ddt',
  recordId: 'd0d0d0d0-0000-4000-8000-000000000042',
  type: { it: 'Documento di trasporto', en: 'Delivery note' },
  label: 'DDT-2026-0042',
  theirRef: null,
  state: { code: 'ISSUED', words: { it: 'Emesso', en: 'Issued' } },
  parent: { recordType: 'SalesOrder', recordId: BRAND_ALPHA.ids.order, type: { it: 'Ordine di vendita', en: 'Sales order' }, label: BRAND_ALPHA.numbers.order },
}

const nonconformance: RecordSummary = {
  recordType: 'Nonconformance',
  recordId: 'd0d0d0d0-0000-4000-8000-000000000007',
  type: { it: 'Non conformità', en: 'Nonconformance' },
  label: 'NC-2026-0007',
  theirRef: null,
  state: { code: 'INVESTIGATING', words: { it: 'In analisi', en: 'Investigating' } },
  parent: null,
}

const approvalTask: RecordSummary = {
  recordType: 'ApprovalTask',
  recordId: 'd0d0d0d0-0000-4000-8000-000000000031',
  type: { it: 'Richiesta di un sì', en: 'Request for a yes' },
  label: null,
  theirRef: null,
  state: null,
  parent: { recordType: 'Quote', recordId: 'd0d0d0d0-0000-4000-8000-000000000032', type: { it: 'Offerta', en: 'Quote' }, label: 'Q-2026-0033' },
}

const ready = (summary: RecordSummary, thread: RecordDockedInput | null): GenericCase => ({
  model: { prefix: PREFIX, recordType: summary.recordType, recordId: summary.recordId, state: 'ready', summary, opener: { ...NO_OPENER, label: summary.label }, parentHref: parentHrefOf(summary, PREFIX, OFFICE_PAGES) },
  thread,
})

const without = (state: GenericRecordModel['state'], opener: Opener = NO_OPENER): GenericCase => ({
  model: { prefix: PREFIX, recordType: 'Ddt', recordId: deliveryNote.recordId, state, summary: null, opener, parentHref: null },
  thread: null,
})

export const designScreen = defineDesignScreen<GenericCase>({
  screen: 'SCR-006-generic',
  title: 'Generic record page',
  view: GenericDesign,
  cases: [
    {
      id: 'with-party',
      label: 'Delivery note of a customer order',
      model: ready(deliveryNote, { recordType: 'Ddt', record: 'DDT-2026-0042', party: { name: BRAND_ALPHA.tradeName, role: 'customer' } }),
      note: 'Band: ‹ Home, "Delivery note DDT-2026-0042", ONE pill (the API’s words), "Part of Sales order SO-…" as a link. The thread ~2/3 with "Reply to Brand Alpha"; the summary ~1/3 (behind "Details" below 1280 px, an "i" on a phone).',
    },
    {
      id: 'notes-only',
      label: 'Nonconformance, notes only',
      model: ready(nonconformance, { recordType: 'Nonconformance', record: 'NC-2026-0007', party: null }),
      note: 'No party: office notes only, no "Reply to"; no parent, so no "Part of" line.',
    },
    {
      id: 'no-number-no-state',
      label: 'No number, no state',
      model: ready(approvalTask, { recordType: 'ApprovalTask', record: 'Q-2026-0033', party: null }),
      note: 'The title is the type alone; "No number" in the summary; no pill (a record with no state); the parent quote opens its own page.',
    },
    { id: 'reading', label: 'Reading (the opener’s label)', model: without('loading', { ...NO_OPENER, label: 'DDT-2026-0042' }), note: 'The band shows the label the opener gave; the thread and the summary wait as skeletons.' },
    { id: 'missing', label: 'Not in the reader’s scope (404)', model: without('missing'), note: '"You cannot see this record" — the same words whether it does not exist or is outside the reader’s scope; no thread.' },
    { id: 'no-right', label: 'No right to read threads (403)', model: without('noRight'), note: 'The right in words, never its code.' },
    { id: 'error', label: 'A problem', model: without('error'), note: 'Try again, inside the page.' },
  ],
})
