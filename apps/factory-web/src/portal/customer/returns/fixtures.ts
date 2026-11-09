import { defineDesignScreen } from '../../../lib/design/design-screen'
import type { Locale } from '../../../lib/i18n/locales'
import type { CaseChip } from './api'
import { listBandOf } from './band'
import { at, CASES, casesRead, complaintsRead, PREFIX, returnableRead, returnWords, shellOf, words } from './design-data'
import { EMPTY_START, startProblems, type StartDraft } from './model'
import type { ReturnsListViewModel } from './view/ReturnsListView'
import { ReturnsCase, type ReturnsCaseBuilder } from './view/ReturnsCase'
import type { StartDialogModel } from './view/StartDialog'

/**
 * SCR-187 › Returns & claims (design portal.customer.returns: sec:cases, sec:complaints, h.act "Start a return or claim";
 * B-W2b-197), MADE-UP data only: the open cases (the default chip) with the Quality role's complaints, waiting for you,
 * closed, every case, rows selected for Export N, a buyer who does not follow complaints, a colleague who may only read,
 * nothing yet, nothing matching, loading, a failed read (the cases, the complaints), changes waiting, no connection, the
 * keys, the page for a person without it, an office preview, and every step of "Start a return or claim" (what you
 * need, a return's items, a complaint's details, the problems at their fields, check and send, sending, refused, discard,
 * sent).
 */

function listModel(over: Partial<ReturnsListViewModel> = {}): ReturnsListViewModel {
  return {
    state: 'ready',
    read: casesRead(),
    chip: null,
    q: '',
    prefix: PREFIX,
    selected: [],
    updates: 0,
    offlineSince: null,
    complaints: { state: 'ready', read: complaintsRead() },
    startHeld: null,
    start: null,
    ...over,
  }
}

function listCase(build: (locale: Locale) => Partial<ReturnsListViewModel> = () => ({}), held: (locale: Locale) => string | null = () => null, shellOver: Partial<Parameters<typeof shellOf>[2]> = {}): ReturnsCaseBuilder {
  return (locale) => {
    const model = listModel({ startHeld: held(locale), ...build(locale) })
    return {
      shell: shellOf(locale, listBandOf({ words: returnWords(locale), asOf: model.read?.asOf ?? null, startHeld: held(locale) }), shellOver),
      body: { kind: 'list', model },
    }
  }
}

const chipCase = (chip: CaseChip) => listCase(() => ({ chip, read: casesRead(chip) }))

function startModel(draft: Partial<StartDraft>, over: Partial<StartDialogModel> = {}): StartDialogModel {
  const full: StartDraft = { ...EMPTY_START, ...draft }
  const read = returnableRead()
  return { state: 'ready', read, draft: full, problems: full.tried ? startProblems(full, read) : {}, held: null, busy: false, problem: null, discard: false, sent: null, ...over }
}

const picked = { picked: true, quantity: '2', reasonCode: 'DAMAGED_IN_TRANSIT', reasonNote: '', serial: 'SN-DEMO-000123' }
const returnDraft: Partial<StartDraft> = { step: 'details', type: 'RETURN', lines: { 'line-1|52': picked }, outcomeWanted: 'REPLACE', customerRef: 'BA-RES-12', note: 'Le cerniere sono rovinate: preferiremmo una sostituzione prima della fiera.' }
const complaintDraft: Partial<StartDraft> = { step: 'details', type: 'COMPLAINT', itemKey: 'line-1|54', serial: 'SN-DEMO-000777', batchNumber: 'LOT-DEMO-26-04', description: 'La cucitura della spalla sinistra si è aperta dopo due uscite in moto.', customerRef: 'BA-QC-10' }
const startCase = (draft: Partial<StartDraft>, over: Partial<StartDialogModel> = {}) => listCase(() => ({ start: startModel(draft, over) }))

export const designScreen = defineDesignScreen<ReturnsCaseBuilder>({
  screen: 'SCR-187',
  title: 'Customer Returns & claims (portal.customer.returns)',
  view: ReturnsCase,
  cases: [
    { id: 'normal', label: 'Open cases (the default chip) and the complaints', model: listCase(), note: 'Their reference first, our case second; the type, the item (size, serial), opened, the status in customer words and the next step — "Your move" when it is theirs; then the Quality role’s complaints with the 8D step reached and the answer due. No money on this page.' },
    { id: 'waiting', label: 'Waiting for you', model: chipCase('WAITING'), note: 'The cases whose next step is the customer’s (print the label and send it back, answer our question).' },
    { id: 'closed', label: 'Closed cases', model: chipCase('CLOSED') },
    { id: 'all', label: 'Every case', model: chipCase('ALL') },
    { id: 'selected', label: 'Two cases selected', model: listCase(() => ({ chip: 'ALL', read: casesRead('ALL'), selected: [`RETURN:${CASES[0]!.id}`, `COMPLAINT:${CASES[2]!.id}`] })), note: 'The bulk action takes the search’s place: Export 2 (CSV of the selected cases).' },
    { id: 'buyer', label: 'A buyer: no complaints section', model: listCase(() => ({ complaints: { state: 'hidden', read: null }, read: casesRead('OPEN', null, { readsComplaints: false }) })), note: 'A complaint shows as a case with its status and next step; the investigation, the letter and the 8D are for the Quality role.' },
    {
      id: 'viewer',
      label: 'A colleague who may only read',
      model: listCase(
        () => ({ read: casesRead('OPEN', null, { mayRequest: false }) }),
        (locale) => words(locale)('held.mayRequest'),
      ),
      note: '“Start a return or claim” is held and says why (focusable).',
    },
    {
      id: 'empty',
      label: 'A new customer: no returns or claims',
      model: listCase(() => ({ read: casesRead('OPEN', []), complaints: { state: 'ready', read: complaintsRead({ items: [] }) } })),
      note: '“No returns or claims.” + Start a return or claim; “No complaints.”',
    },
    { id: 'no-match', label: 'Nothing matches the search', model: listCase(() => ({ chip: 'ALL', q: 'BA-RES-99', read: casesRead('ALL', []) })), note: '“No case matches these filters” + Clear filters.' },
    { id: 'loading', label: 'Loading', model: listCase(() => ({ state: 'loading', read: null, complaints: { state: 'loading', read: null } })) },
    { id: 'error', label: 'The cases could not be read', model: listCase(() => ({ state: 'error', read: null, complaints: { state: 'error', read: null } })), note: 'A failed read is never drawn as an empty list; the complaints say so too.' },
    { id: 'updates', label: 'Changes waiting', model: listCase(() => ({ updates: 2 })), note: 'Rows never move under the pointer: “2 updates · Show”.' },
    { id: 'offline', label: 'No connection', model: listCase(() => ({ offlineSince: at(-1) }), (locale) => words(locale)('held.offline')), note: '“No connection — showing what was loaded at …”; Start is held with the reason.' },
    { id: 'keys', label: 'The keys in the footer’s info icon', model: listCase(() => ({ keysOpen: true })), note: 'Key hints only in the table footer (Owner rule 2026-10-29).' },
    {
      id: 'preview',
      label: 'An office preview',
      model: listCase(
        () => ({}),
        (locale) => words(locale)('held.preview'),
        { preview: true },
      ),
      note: 'The frame names the preview; Start a return or claim is held with the reason.',
    },
    {
      id: 'no-access',
      label: 'Not part of the person’s access',
      model: (locale) => ({ shell: shellOf(locale, { title: words(locale)('list.title') }), body: { kind: 'noAccess', admins: ['Anna Esempio'] } }),
      note: 'A typed or old address (a designer, a supplier): who to ask, and Home. Not in the navigation (fails closed).',
    },
    { id: 'start', label: 'Start › What you need', model: startCase({}), note: 'Two big choice cards: return items, or report a quality problem (repair, remake and safety come with W2b-5). ← → move between steps outside a field.' },
    { id: 'start-type-problem', label: 'Start › nothing chosen', model: startCase({ tried: true }, { problems: { type: 'start.problem.type' } }), note: 'Next without a choice: the problem at the choice.' },
    { id: 'start-return', label: 'Start › a return’s items', model: startCase(returnDraft), note: 'What we delivered that may still come back: each item with its pieces (up to what is left), the reason (a word more when the reason needs it), the serial; an item already back is shown and not pickable; outside the window it says so. What you would like, your reference, a note.' },
    { id: 'start-return-problems', label: 'Start › a return with problems', model: startCase({ ...returnDraft, tried: true, lines: { 'line-1|52': { ...picked, quantity: '9', reasonCode: 'DEFECT' } } }), note: 'Next with problems: each at its field (more than can come back, a reason that needs a word more).' },
    { id: 'start-complaint', label: 'Start › a complaint’s details', model: startCase(complaintDraft), note: 'The item from what we delivered (or none), serial, batch, what happened (needed), your reference.' },
    { id: 'start-review', label: 'Start › check and send (a return)', model: startCase({ ...returnDraft, step: 'review' }), note: 'One screen: the items, pieces and reasons, what you would like, your reference and note. Photos are added on the case once it is sent.' },
    { id: 'start-review-complaint', label: 'Start › check and send (a complaint)', model: startCase({ ...complaintDraft, step: 'review' }) },
    { id: 'start-sending', label: 'Start › sending', model: startCase({ ...returnDraft, step: 'review' }, { busy: true, held: 'held.busy' }), note: 'Send and Close are held while it goes.' },
    { id: 'start-refused', label: 'Start › refused (pieces taken meanwhile)', model: startCase({ ...returnDraft, step: 'review' }, { problem: 'start.problem.tooManyNow' }), note: 'A refusal in our words; what may come back is read again.' },
    { id: 'start-discard', label: 'Start › close with typed work', model: startCase(returnDraft, { discard: true }), note: '“Discard what you typed?” — Stay / Discard.' },
    { id: 'start-loading', label: 'Start › reading what may come back', model: startCase({ step: 'details', type: 'RETURN' }, { state: 'loading', read: null }) },
    { id: 'start-error', label: 'Start › what may come back could not be read', model: startCase({ step: 'details', type: 'RETURN' }, { state: 'error', read: null }) },
    { id: 'start-empty', label: 'Start › nothing can come back', model: startCase({ step: 'details', type: 'RETURN' }, { read: returnableRead({ items: [] }) }), note: 'Nothing delivered may come back now: a quality problem is reported instead.' },
    { id: 'start-sent', label: 'Start › sent (EndState)', model: startCase({ ...returnDraft, step: 'review' }, { sent: { type: 'RETURN', number: 'R-2026-0037', answerBy: '2026-11-11', href: `${PREFIX}/returns/x?tab=request` } }), note: 'The case number (copy), when we answer, what comes next, Open the request.' },
    { id: 'start-sent-complaint', label: 'Start › sent (a complaint)', model: startCase({ ...complaintDraft, step: 'review' }, { sent: { type: 'COMPLAINT', number: 'C-2026-0025', answerBy: null, href: `${PREFIX}/returns/complaints/x?tab=request` } }) },
  ],
})
