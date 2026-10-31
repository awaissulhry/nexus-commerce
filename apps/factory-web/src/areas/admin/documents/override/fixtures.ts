import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { inShell } from '../../shared/fixtures'
import type { NumberPreview } from './api'
import { emptyDraft, type NumberFieldModel } from './model'
import { NumberFieldFrame } from './view/NumberFieldFrame'

/**
 * SCR-014-override — "Type a number for a migrated document" (B-W2b-24; PLT-125; design admin.documents popup `override`)
 * and the number line of a create dialog (the W1 gap "number preview for GR / LOT / PO"), with made-up numbers of a Demo
 * company: the line for a person who may only see the next number, for one who may type a migrated document's number, the
 * typed number in use, and the popup's states (clashes said at once, Use held with the reason).
 */

const preview = (over: Partial<NumberPreview> = {}): NumberPreview => ({
  companyId: '0190f0e2-6161-7000-8000-000000000001',
  kind: 'PURCHASE_ORDER',
  date: '2026-10-31',
  code: 'MAIN',
  scopeKey: '2026',
  number: 'PO-2026-00018',
  fiscal: false,
  newPeriod: false,
  held: null,
  ...over,
})

const field = (over: Partial<NumberFieldModel> = {}): NumberFieldModel => ({ kind: 'PURCHASE_ORDER', preview: { state: 'ready', value: preview() }, canOverride: true, typed: null, dialog: null, ...over })
const draft = (over: Partial<ReturnType<typeof emptyDraft>> = {}) => ({ ...emptyDraft('PURCHASE_ORDER'), ...over })

function OverrideDesign({ model }: { model: NumberFieldModel }) {
  return inShell('/purchasing/orders', createElement(NumberFieldFrame, { model }))
}

export const designScreen = defineDesignScreen<NumberFieldModel>({
  screen: 'SCR-014-override',
  title: 'Type a number for a migrated document',
  view: OverrideDesign,
  cases: [
    { id: 'line-preview', label: 'The number it will get (no right to type one)', model: field({ canOverride: false }), note: 'Said as not reserved: another order may take it first; the number is given when the order is saved.' },
    { id: 'line-may-type', label: 'The number it will get, with "Type a number for a migrated document…"', model: field(), note: 'Only for who holds numbering.override, and only for kinds a migrated document may keep its number for (never invoices, credit notes, DDTs).' },
    { id: 'line-typed', label: 'A migrated order keeps its old number', model: field({ typed: { number: 'OA-19-0412', reason: 'Open order of the old system' } }), note: '"Use the series\' number" goes back to the next number of the series.' },
    { id: 'line-new-year', label: 'The first number of a new year', model: field({ preview: { state: 'ready', value: preview({ scopeKey: '2027', number: 'PO-2027-00001', newPeriod: true }) } }) },
    { id: 'line-no-series', label: 'No series for this kind yet', model: field({ canOverride: false, preview: { state: 'ready', value: preview({ number: null, scopeKey: null, code: null, held: 'noSeries' }) } }) },
    { id: 'line-closed', label: 'Its series is closed', model: field({ canOverride: false, preview: { state: 'ready', value: preview({ number: null, held: 'closed' }) } }) },
    { id: 'line-loading', label: 'Reading the next number', model: field({ preview: { state: 'loading' } }) },
    { id: 'line-failed', label: 'The next number could not be read', model: field({ preview: { state: 'failed' } }), note: 'The order is still numbered when it is saved: nothing is held.' },
    { id: 'override-empty', label: 'The popup, empty: Use is held until a number is typed', model: field({ dialog: draft() }) },
    { id: 'override-checking', label: 'Checking the typed number', model: field({ dialog: draft({ number: 'OA-19-0412', check: 'checking' }) }) },
    { id: 'override-free', label: 'The number is free: Use waits for the reason', model: field({ dialog: draft({ number: 'OA-19-0412', check: 'ok' }) }) },
    { id: 'override-ready', label: 'Free and explained: Use this number', model: field({ dialog: draft({ number: 'OA-19-0412', reason: 'Open order of the old system', check: 'ok' }) }), note: '⌘Enter uses it; nothing is saved until the order is created.' },
    { id: 'override-taken', label: 'Refused at once: another order has this number', model: field({ dialog: draft({ number: 'PO-2026-00007', reason: 'Carried over', check: 'refused', refusal: 'taken' }) }) },
    { id: 'override-future', label: 'Refused at once: the series will give this number later', model: field({ dialog: draft({ number: 'PO-2026-00040', reason: 'Carried over', check: 'refused', refusal: 'future' }) }) },
    { id: 'override-shape', label: 'A number not written as printed (a space)', model: field({ dialog: draft({ number: 'OA 19 0412' }) }) },
    { id: 'override-kind', label: 'A kind that always takes its series\' number', model: field({ dialog: draft({ number: 'FT-2019-0007', check: 'refused', refusal: 'kind' }) }), note: 'The popup is never offered for an invoice, a credit note or a DDT; the API says the same if asked.' },
    { id: 'override-failed', label: 'The check could not be made', model: field({ dialog: draft({ number: 'OA-19-0412', reason: 'Carried over', check: 'failed' }) }) },
  ],
})
