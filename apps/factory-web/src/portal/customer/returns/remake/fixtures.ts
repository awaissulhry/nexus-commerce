import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { Locale } from '../../../../lib/i18n/locales'
import { listBandOf } from '../band'
import { casesRead, complaintsRead, PREFIX, returnableRead, returnWords, shellOf } from '../design-data'
import { EMPTY_START, startProblems, type StartDraft } from '../model'
import { ReturnsCase, type ReturnsCaseBuilder } from '../view/ReturnsCase'
import type { StartDialogModel } from '../view/StartDialog'

/**
 * SCR-187 › Start a return or claim › A remake (B-W2b-346; SAL-298, follow-up RX2:02) — a review id of the same screen, as
 * SCR-187-record. MADE-UP data only: the three choice cards with the remake chosen, the one item and the fit in words,
 * nothing picked and no words (the problems at their fields), nothing that may be remade, check and send, sending,
 * refused (the piece taken meanwhile), and the end that sends the person on to add the front and back photos.
 */

function startModel(draft: Partial<StartDraft>, over: Partial<StartDialogModel> = {}): StartDialogModel {
  const full: StartDraft = { ...EMPTY_START, ...draft }
  const read = returnableRead()
  return { state: 'ready', read, draft: full, problems: full.tried ? startProblems(full, read) : {}, held: null, busy: false, problem: null, discard: false, sent: null, ...over }
}

const startCase =
  (draft: Partial<StartDraft>, over: Partial<StartDialogModel> = {}): ReturnsCaseBuilder =>
  (locale: Locale) => {
    const read = casesRead()
    return {
      shell: shellOf(locale, listBandOf({ words: returnWords(locale), asOf: read.asOf, startHeld: null })),
      body: { kind: 'list', model: { state: 'ready', read, chip: null, q: '', prefix: PREFIX, selected: [], updates: 0, offlineSince: null, complaints: { state: 'ready', read: complaintsRead() }, startHeld: null, start: startModel(draft, over) } },
    }
  }

const remake: Partial<StartDraft> = {
  step: 'details',
  type: 'REMAKE',
  remakeKey: 'line-1|52',
  serial: 'SN-DEMO-000123',
  fit: 'Le maniche sono lunghe circa 3 cm in più e la schiena tira quando sono in posizione sulla moto.',
  customerRef: 'BA-RIF-31',
}

export const designScreen = defineDesignScreen<ReturnsCaseBuilder>({
  screen: 'SCR-187-remake',
  title: 'Returns & claims › Start › A remake (made-to-measure fit)',
  view: ReturnsCase,
  cases: [
    { id: 'type', label: 'What you need · a remake chosen', model: startCase({ type: 'REMAKE' }), note: 'The third choice card: made to measure and it does not fit. Repair and safety come with their own steps.' },
    { id: 'details', label: 'Details · one item and the fit in words', model: startCase(remake), note: 'One item of what may come back (one piece), what is wrong with the fit (needed), the serial, your reference; the photos follow on the request.' },
    { id: 'details-problems', label: 'Details · nothing picked, no words', model: startCase({ step: 'details', type: 'REMAKE', tried: true }), note: 'Next with problems: each at its field.' },
    { id: 'details-none', label: 'Details · nothing can be remade', model: startCase({ step: 'details', type: 'REMAKE' }, { read: returnableRead({ items: [] }) }) },
    { id: 'review', label: 'Check and send · a remake', model: startCase({ ...remake, step: 'review' }), note: 'One screen: the item, the serial, the fit, your reference; the photos are added on the request once it is sent.' },
    { id: 'sending', label: 'Sending', model: startCase({ ...remake, step: 'review' }, { busy: true, held: 'held.busy' }) },
    { id: 'refused', label: 'Refused · the piece was taken meanwhile', model: startCase({ ...remake, step: 'review' }, { problem: 'start.problem.tooManyNow' }), note: 'A refusal in our words; what may come back is read again.' },
    { id: 'sent', label: 'Sent (EndState)', model: startCase({ ...remake, step: 'review' }, { sent: { type: 'REMAKE', number: 'R-2026-0041', answerBy: '2026-11-16', href: `${PREFIX}/returns/x?tab=request` } }), note: 'The number (copy), when we answer, the next step: add the front and back photos on the request (Open the request).' },
  ],
})
