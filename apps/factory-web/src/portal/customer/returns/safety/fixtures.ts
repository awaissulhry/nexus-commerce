import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { Locale } from '../../../../lib/i18n/locales'
import { CATALOGUE, createTranslator } from '../../../../lib/i18n/messages'
import { FRESH_DIALOG, type ReportDialogModel } from '../../../../lib/safety-reports/dialog'
import { EMPTY_INTAKE, NS as SAFETY_NS, type IntakeDraft } from '../../../../lib/safety-reports/intake'
import type { SafetyPhotosModel } from '../../../../lib/safety-reports/view/SafetyPhotos'
import { listBandOf } from '../band'
import { casesRead, complaintsRead, PREFIX, returnableRead, returnWords, shellOf } from '../design-data'
import { EMPTY_START } from '../model'
import type { StartDialogModel } from '../view/StartDialog'
import type { ReturnsListViewModel } from '../view/ReturnsListView'
import { SafetyCase, type SafetyCaseBuilder } from './view/SafetyCase'

/**
 * SCR-187-safety (B-W2b-357; design portal.customer.returns pop:safety-report "Report a safety incident", follow-up GP2:02 —
 * "drawn in the portal") — the customer's Returns & claims with the safety report: the band's ⋯ item (open, or held while the
 * door is closed until the privacy notice is published, for a role that does not send, in an office preview), the start's
 * "Safety incident" card (open and held), the dialog (empty, its problems, someone hurt with the consent and the words,
 * check and send, sending, refused: the door closed meanwhile, no connection), and the end with and without photos. MADE-UP
 * data only.
 */

const TODAY = '2026-11-12'
const sayIn = (locale: Locale) => createTranslator(locale, CATALOGUE[locale][SAFETY_NS] ?? {})

const FILLED: IntakeDraft = {
  ...EMPTY_INTAKE,
  serial: 'SN-DEMO-000456',
  batchNumber: 'L-2240',
  size: '50',
  whatHappened: 'Il rinforzo del ginocchio si è staccato durante una caduta in pista: la protezione è scivolata fuori (dati inventati).',
  worn: 'yes',
  accident: true,
  injured: true,
  consent: true,
  injuryWords: 'Contusione al ginocchio destro, nessuna frattura (inventato).',
  occurredOn: '2026-11-09',
  place: 'Circuito di prova, curva 3 (inventato)',
}

const photos = (over: Partial<SafetyPhotosModel> = {}): SafetyPhotosModel => ({ photos: [], max: 6, until: '2026-11-12T16:40:00Z', held: null, capturing: false, ...over })

function list(locale: Locale, start: StartDialogModel | null = null): ReturnsListViewModel {
  void locale
  const read = casesRead()
  return { state: 'ready', read, chip: null, q: '', prefix: PREFIX, selected: [], updates: 0, offlineSince: null, complaints: { state: 'ready', read: complaintsRead() }, startHeld: null, start }
}

/** The page with the band's ⋯ ("Report a safety incident" open or held with `held`, a key of the catalogue) and maybe the start or the dialog. */
const caseOf =
  (input: { held?: string | null; start?: boolean; dialog?: Partial<ReportDialogModel> | null; offline?: boolean }): SafetyCaseBuilder =>
  (locale) => {
    const t = sayIn(locale)
    const held = input.held ? t(input.held) : null
    const read = casesRead()
    const start: StartDialogModel | null = input.start
      ? { state: 'ready', read: returnableRead(), draft: { ...EMPTY_START, step: 'type' }, problems: {}, held: null, busy: false, problem: null, discard: false, sent: null, safety: { held } }
      : null
    return {
      shell: shellOf(locale, listBandOf({ words: returnWords(locale), asOf: read.asOf, startHeld: null, safety: { label: t('portal.open'), held, onOpen: () => undefined } })),
      list: list(locale, start),
      dialog: input.dialog === undefined || input.dialog === null ? null : { dialog: { ...FRESH_DIALOG, ...input.dialog }, door: 'portal', fixedBatch: null, today: TODAY, keeper: null, camera: false, contact: null, offline: input.offline ?? false },
    }
  }

export const designScreen = defineDesignScreen<SafetyCaseBuilder>({
  screen: 'SCR-187-safety',
  title: 'Returns & claims › Report a safety incident (the portal’s safety report)',
  view: SafetyCase,
  cases: [
    { id: 'menu', label: 'The band’s ⋯ holds Report a safety incident (the door open)', model: caseOf({}), note: 'Open the ⋯ menu in the band: the item opens the dialog.' },
    { id: 'menu-closed', label: 'Closed until the privacy notice is published: the item held with why', model: caseOf({ held: 'portal.held.closed' }), note: 'GATE-PRIVACY: the item says why it waits and what to do meanwhile.' },
    { id: 'menu-no-request', label: 'A role that follows cases but does not send them: held with why', model: caseOf({ held: 'portal.held.noRequest' }) },
    { id: 'menu-preview', label: 'The office’s preview of the portal: held', model: caseOf({ held: 'portal.held.preview' }) },
    { id: 'start-card', label: 'Start a return or claim · the “Safety incident” card', model: caseOf({ start: true }), note: 'Choosing it closes the start and opens the safety report’s own dialog.' },
    { id: 'start-card-closed', label: 'Start · the card held while the door is closed', model: caseOf({ start: true, held: 'portal.held.closed' }) },
    { id: 'form', label: 'Report a safety incident · the empty form', model: caseOf({ dialog: {} }), note: 'The serial or the batch (required), what happened, worn as intended, an accident, anyone hurt (required), when and where; the person is known (no contact fields).' },
    { id: 'form-problems', label: 'Next with nothing typed: the problems at their fields', model: caseOf({ dialog: { tried: true } }) },
    { id: 'form-hurt', label: 'Someone hurt, the consent ticked, the injury in words', model: caseOf({ dialog: { draft: FILLED } }), note: 'GDPR art. 9: the words only after the explicit consent tick; read only by the product-safety team.' },
    { id: 'review', label: 'Check and send', model: caseOf({ dialog: { step: 'review', draft: FILLED } }) },
    { id: 'sending', label: 'Sending', model: caseOf({ dialog: { step: 'review', draft: FILLED, busy: true } }) },
    { id: 'refused-closed', label: 'Refused: the door closed meanwhile (the notice is not in force)', model: caseOf({ held: 'portal.held.closed', dialog: { step: 'review', draft: FILLED, refusal: { key: 'refused.offPortal', wait: null } } }) },
    { id: 'offline', label: 'No connection: Send held with why, the typed words stay', model: caseOf({ offline: true, held: 'portal.held.offline', dialog: { step: 'review', draft: FILLED } }) },
    { id: 'sent', label: 'Sent: the number, our quality team reads it today, the photos', model: caseOf({ dialog: { draft: FILLED, sent: { number: 'PSR-2026-0008' }, photos: photos({ photos: [{ key: 'a', name: 'PSR-2026-0008-photo-1.jpg', state: 'sent' }] }) } }) },
    { id: 'sent-no-photos', label: 'Sent by a role that does not upload: no photos part', model: caseOf({ dialog: { draft: FILLED, sent: { number: 'PSR-2026-0009' }, photos: null } }) },
  ],
})
