import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { Locale } from '../../../../lib/i18n/locales'
import type { NoticePage } from '../api'
import { newBandOf, noticeBandOf } from '../band'
import { dayAt, draftPage, HIDES, noticePage, ORDER, PREFIX, sheetRead, shellOf, SHIPPABLE, words } from '../design-data'
import { linesDraftOf, shipLinesOf, termsDraftOf, type Step } from '../model'
import type { AnnounceViewModel } from '../view/AnnounceView'
import { DeliveriesCase, type DeliveriesCaseBuilder } from '../view/DeliveriesCase'

/**
 * SCR-227 › Announce a delivery (design portal.supplier.asn sub-page `announce`: pick-lines, packing-list, transport, review;
 * pop:row-detail "Hide 2231-017"; tab:template; B-W2b-186), MADE-UP data only: the order to ship from, each of the four steps
 * with its held and refused states, the tannery's sheet read with a verdict per row (and rows that do not read), a hide's
 * detail, the list kept, a delivery without leather, the send's end, a sent notice being changed, offline, loading, error.
 */

const FACTS = { mayWrite: true, preview: false, offline: false, busy: false }

function model(input: { step: Step; page?: NoticePage | null; locale: Locale; over?: Partial<AnnounceViewModel> }): AnnounceViewModel {
  const page = input.page ?? null
  const choices = SHIPPABLE.orders[0]!.lines
  const lines = shipLinesOf({ choices, notice: page?.notice ?? null, addable: page?.addable ?? [] })
  return {
    state: 'ready',
    prefix: PREFIX,
    orders: null,
    order: ORDER,
    step: input.step,
    changing: false,
    page,
    lines,
    linesDraft: linesDraftOf(lines, page?.notice ?? null, input.locale),
    terms: termsDraftOf(page?.notice ?? null),
    sendNote: page?.notice.note ?? '',
    sheet: { state: 'idle' },
    facts: FACTS,
    problem: null,
    done: null,
    ...input.over,
  }
}

function stepCase(step: Step, build: (locale: Locale) => { page?: NoticePage | null; over?: Partial<AnnounceViewModel> } = () => ({})): DeliveriesCaseBuilder {
  return (locale) => {
    const t = words(locale)
    const { page = null, over = {} } = build(locale)
    const view = model({ step, page, locale, over })
    const band = page ? noticeBandOf({ t, locale, prefix: PREFIX, page, stepping: !view.done, changeHeld: null }) : newBandOf({ t, locale, prefix: PREFIX, order: view.order })
    return { shell: shellOf(locale, { band }), body: { kind: 'announce', model: view } }
  }
}

const keptDraft = () => draftPage({ hides: HIDES })
const termsDraft = () => draftPage({ hides: HIDES.filter((hide) => hide.verdict !== 'NOT_AS_ORDERED'), terms: true })

export const designScreen = defineDesignScreen<DeliveriesCaseBuilder>({
  screen: 'SCR-227-announce',
  title: 'Supplier Ship notices › Announce a delivery (portal.supplier.asn › announce)',
  view: DeliveriesCase,
  cases: [
    {
      id: 'pick',
      label: 'Which order (no order in the address)',
      model: (locale) => ({ shell: shellOf(locale, { band: newBandOf({ t: words(locale), locale, prefix: PREFIX, order: null }) }), body: { kind: 'announce', model: { ...model({ step: 'lines', locale }), order: null, orders: SHIPPABLE.orders } } }),
      note: 'The confirmed orders with lines still to deliver; one notice is one order.',
    },
    {
      id: 'pick-empty',
      label: 'No confirmed lines to ship',
      model: (locale) => ({ shell: shellOf(locale, { band: newBandOf({ t: words(locale), locale, prefix: PREFIX, order: null }) }), body: { kind: 'announce', model: { ...model({ step: 'lines', locale }), order: null, orders: [] } } }),
    },
    {
      id: 'not-shippable',
      label: 'The order in the address has nothing to ship',
      model: (locale) => ({ shell: shellOf(locale, { band: newBandOf({ t: words(locale), locale, prefix: PREFIX, order: null }) }), body: { kind: 'announce', model: { ...model({ step: 'lines', locale }), order: null, orders: SHIPPABLE.orders, problem: { problem: 'notShippable', issues: [] } } } }),
    },
    { id: 'lines', label: '1 · What you ship (from PO-2026-0101)', model: stepCase('lines'), note: 'The open lines, preselected in full; a quantity per line (partial allowed, a line left out stays open), the dye batch and your lot. Next creates the draft.' },
    {
      id: 'lines-problem',
      label: '1 · A quantity that does not read, one over what is open',
      model: stepCase('lines', (locale) => {
        const lines = shipLinesOf({ choices: SHIPPABLE.orders[0]!.lines })
        const draft = linesDraftOf(lines, null, locale)
        return { over: { linesDraft: { ...draft, [lines[0]!.id]: { ...draft[lines[0]!.id]!, quantity: locale === 'it' ? '1.350' : '1,350' }, [lines[1]!.id]: { ...draft[lines[1]!.id]!, quantity: '12,4,5' } } } }
      }),
      note: 'The line in red says why; Next is held with the reason. Over what is open is a hint: the check will say “Not as ordered”.',
    },
    { id: 'lines-none', label: '1 · Every line taken off', model: stepCase('lines', (locale) => ({ over: { linesDraft: Object.fromEntries(Object.entries(linesDraftOf(shipLinesOf({ choices: SHIPPABLE.orders[0]!.lines }), null, locale)).map(([key, value]) => [key, { ...value, include: false }])) } })) },
    { id: 'packing', label: '2 · Leather packing list: nothing yet', model: stepCase('packing', () => ({ page: draftPage() })), note: 'Upload CSV or Excel (the template in Excel or CSV beside it), or go on without: we measure every hide at the dock.' },
    { id: 'packing-reading', label: '2 · Reading the sheet', model: stepCase('packing', () => ({ page: draftPage(), over: { sheet: { state: 'reading', fileName: 'distinta-2231.xlsx' } } })) },
    { id: 'packing-read', label: '2 · The sheet read: verdict per row and per line', model: stepCase('packing', () => ({ page: draftPage(), over: { sheet: { state: 'read', fileName: 'distinta-2231.xlsx', read: sheetRead(false), keeping: false } } })), note: 'OK / Check (amber, reason) / Not as ordered (red, reason) per hide and per line, BEFORE anything is kept. Enter or a click on a check opens the hide’s detail. Keep this list, or choose another file.' },
    { id: 'packing-unreadable', label: '2 · Rows that do not read', model: stepCase('packing', () => ({ page: draftPage(), over: { sheet: { state: 'read', fileName: 'distinta-2231.xlsx', read: sheetRead(true), keeping: false } } })), note: '“Row 14: the area is not a number above 0.” “Hide 2231-002 is listed twice (row 3 too).” Keep is held: fix the file and upload it again.' },
    { id: 'row-detail', label: 'Pop-up: Hide 2231-017', model: stepCase('packing', () => ({ page: draftPage(), over: { sheet: { state: 'read', fileName: 'distinta-2231.xlsx', read: sheetRead(false), keeping: false }, openHide: 'row-6' } })), note: 'The values and why it is Not as ordered. Esc closes and gives the focus back.' },
    { id: 'packing-kept', label: '2 · The list kept', model: stepCase('packing', () => ({ page: keptDraft() })), note: 'The list with its checks; replace it with another file, or remove it.' },
    { id: 'packing-failed', label: '2 · A file that is no packing list', model: stepCase('packing', () => ({ page: draftPage(), over: { sheet: { state: 'failed', fileName: 'ordine.pdf', problem: 'invalid', issues: ['issue.headers'] } } })) },
    { id: 'packing-kept-row-detail', label: 'Pop-up: a kept hide’s detail', model: stepCase('packing', () => ({ page: keptDraft(), over: { openHide: HIDES[4]!.id } })) },
    { id: 'no-leather', label: '2 · A delivery without leather', model: stepCase('packing', () => ({ page: draftPage({ leather: false }) })) },
    { id: 'transport', label: '3 · Transport and papers', model: stepCase('transport', () => ({ page: termsDraft() })), note: 'Ships on, arrives on (our dock plans by it), packages, carrier, tracking, your reference, your DDT and its date, a note for our dock. “The DDT travels with the goods.”' },
    {
      id: 'transport-problem',
      label: '3 · Arrives before it leaves',
      model: stepCase('transport', () => {
        const page = draftPage({ hides: HIDES })
        return { page, over: { terms: { ...termsDraftOf(page.notice), shipDate: dayAt(4), expectedDate: dayAt(2), parcels: '0', ddtDate: dayAt(1), ddtNumber: '' } } }
      }),
    },
    { id: 'review', label: '4 · Review and send', model: stepCase('review', () => ({ page: termsDraft() })), note: 'Lines with their checks, the packing list, transport; Send ship notice.' },
    { id: 'review-not-as-ordered', label: '4 · Something not as ordered: a note', model: stepCase('review', () => ({ page: { ...keptDraft(), notice: { ...keptDraft().notice, ...termsDraft().notice, lines: keptDraft().notice.lines, verdict: 'NOT_AS_ORDERED', note: null } }, over: { sendNote: '' } })), note: 'It can still be sent: the note for our dock says why (we decide at receipt). Send is held until it is typed.' },
    { id: 'review-held', label: '4 · What holds the send', model: stepCase('review', () => ({ page: { ...draftPage(), sendHeld: ['Give the day the goods leave.', 'Give the day the goods arrive: our dock plans by it.', 'A test report is needed before sent: none is on file.'], warnings: ['…'] } })), note: 'Each reason in our words with a Fix link; a required document counted; documents to bring said once.' },
    { id: 'sending', label: '4 · Sending', model: stepCase('review', () => ({ page: termsDraft(), over: { facts: { ...FACTS, busy: true } } })) },
    { id: 'refused', label: '4 · Changed elsewhere meanwhile', model: stepCase('review', () => ({ page: termsDraft(), over: { problem: { problem: 'changed', issues: [] }, stale: true } })), note: 'Typed work is never overwritten: read it again, then try once more.' },
    {
      id: 'done',
      label: 'Delivery announced',
      model: stepCase('review', () => ({ page: noticePage(), over: { done: { id: noticePage().notice.id, number: 'ASN-2026-0014', expectedDate: dayAt(1), site: 'Stabilimento Demo A' } } })),
      note: '“Delivery announced. We expect it on … at Stabilimento Demo A.” with the notice’s number to quote.',
    },
    { id: 'changing', label: 'A sent notice being changed (1 · What you ship)', model: stepCase('lines', () => ({ page: noticePage(), over: { changing: true } })), note: 'Editable until received: each step saves (Save and continue); our warehouse sees the change at once.' },
    { id: 'changing-review', label: 'A sent notice being changed (4 · Review)', model: stepCase('review', () => ({ page: noticePage(), over: { changing: true } })) },
    { id: 'offline', label: 'No connection', model: stepCase('transport', () => ({ page: termsDraft(), over: { facts: { ...FACTS, offline: true } } })), note: 'What sends is held with “No connection”; typed text stays.' },
    { id: 'viewer', label: 'A colleague who may only read', model: stepCase('lines', () => ({ page: draftPage(), over: { facts: { ...FACTS, mayWrite: false } } })) },
    { id: 'loading', label: 'Loading', model: stepCase('lines', () => ({ over: { state: 'loading' } })) },
    { id: 'error', label: 'The delivery could not be read', model: stepCase('lines', () => ({ over: { state: 'error' } })) },
  ],
})
