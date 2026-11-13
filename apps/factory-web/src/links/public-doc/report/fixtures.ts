import { defineDesignScreen } from '../../../lib/design/design-screen'
import { EMPTY_INTAKE, type IntakeDraft } from '../../../lib/safety-reports/intake'
import type { SafetyPhotosModel } from '../../../lib/safety-reports/view/SafetyPhotos'
import { designScreen as publicDoc } from '../fixtures'
import type { PublicDocViewModel } from '../model'
import { PublicDocView } from '../view/PublicDocView'
import type { ReportDialogModel } from '../../../lib/safety-reports/dialog'
import type { PublicReportModel } from './model'

/**
 * SCR-102-report (B-W2b-357; links.doc › sec:report "Report a problem", follow-up GP2:01) — the public DoC page's report:
 * the door open (the button), closed until the privacy notice is published (said, with whom to write to), reading, failed;
 * the dialog's form (empty, its problems, someone hurt with and without the consent tick, a style's page where the serial or
 * batch is asked), check and send, sending and the device check, refused (a wait, the company's notice not in force, a field
 * the API named), discard, the end with its number, photos sending / sent / failed, and the photos' time over. MADE-UP data
 * only: SCR-102's own pages, made-up words.
 */

const caseOf = (id: string): PublicDocViewModel => publicDoc.cases.find((entry) => entry.id === id)!.model
const TODAY = '2026-11-12'

const base = (over: Partial<PublicReportModel> = {}): PublicReportModel => ({
  door: 'open',
  contact: { name: 'Officina Demo S.r.l.', email: 'qualita@officina-demo.example' },
  batch: 'L-2231',
  keeper: 'Officina Demo S.r.l.',
  today: TODAY,
  camera: false,
  dialog: null,
  ...over,
})

const FILLED: IntakeDraft = {
  ...EMPTY_INTAKE,
  serial: 'SN-DEMO-000123',
  size: '52',
  whatHappened: 'In una scivolata a bassa velocità la cucitura della spalla sinistra si è aperta e la protezione è uscita dalla tasca (dati inventati).',
  worn: 'yes',
  accident: true,
  injured: false,
  occurredOn: '2026-11-08',
  place: 'Strada provinciale, curva in discesa (inventato)',
  email: 'lettore@example.com',
}

const dialog = (over: Partial<ReportDialogModel> = {}): ReportDialogModel => ({ step: 'form', draft: EMPTY_INTAKE, tried: false, refusedFields: {}, busy: false, checking: false, refusal: null, discard: false, scanning: false, sent: null, photos: null, ...over })

const photos = (over: Partial<SafetyPhotosModel> = {}): SafetyPhotosModel => ({ photos: [], max: 6, until: '2026-11-12T16:40:00Z', held: null, capturing: false, ...over })

const on = (model: PublicDocViewModel, report: PublicReportModel): PublicDocViewModel => ({ ...model, report })
const batch = (report: PublicReportModel) => on(caseOf('batch-current'), report)

export const designScreen = defineDesignScreen<PublicDocViewModel>({
  screen: 'SCR-102-report',
  title: 'Public DoC: Report a problem (the public safety report)',
  view: PublicDocView,
  cases: [
    { id: 'open', label: 'The door is open: Report a problem before Type the code', model: batch(base()), note: 'One card after the earlier versions (the design’s order): a sentence and the button to the form.' },
    { id: 'closed', label: 'Closed until the privacy notice is published: said, with whom to write to', model: batch(base({ door: 'closed' })), note: 'GATE-PRIVACY: no form, no button that leads nowhere; the page’s conversation address.' },
    { id: 'closed-no-mail', label: 'Closed, the maker set no conversation address', model: batch(base({ door: 'closed', contact: null })) },
    { id: 'loading', label: 'Reading whether reports can be sent here', model: batch(base({ door: 'loading' })) },
    { id: 'failed', label: 'The read failed: in words, with Try again', model: batch(base({ door: 'failed' })) },
    { id: 'form', label: 'Tell us: the batch from the QR, the empty form', model: batch(base({ dialog: dialog() })), note: 'The garment (serial typed or scanned, the batch from the QR, size), what happened, worn as intended, an accident, anyone hurt (required), when and where, how to reach you.' },
    { id: 'form-problems', label: 'Next with nothing typed: the problems at their fields', model: batch(base({ dialog: dialog({ tried: true }) })) },
    { id: 'form-hurt-no-consent', label: 'Someone was hurt, no consent tick: the injury field is not there', model: batch(base({ dialog: dialog({ draft: { ...FILLED, injured: true } }) })), note: 'GDPR art. 9: the injury field appears only after the explicit consent tick; the day and the place are asked.' },
    { id: 'form-hurt-consent', label: 'Someone was hurt, consent ticked: the injury in words', model: batch(base({ dialog: dialog({ draft: { ...FILLED, injured: true, consent: true, injuryWords: 'Escoriazione alla spalla, medicata in pronto soccorso (inventato).' } }) })) },
    { id: 'form-accident-needs', label: 'An accident without the day or the place: both asked', model: batch(base({ dialog: dialog({ tried: true, draft: { ...FILLED, occurredOn: '', place: '' } }) })) },
    {
      id: 'style-page',
      label: 'A style’s page (no batch from the QR): the serial or the batch is asked',
      model: on(caseOf('style-current'), base({ batch: null, dialog: dialog({ tried: true, draft: { ...FILLED, serial: '' } }) })),
    },
    { id: 'review', label: 'Check and send: the report as it goes', model: batch(base({ dialog: dialog({ step: 'review', draft: FILLED }) })) },
    { id: 'sending', label: 'Sending', model: batch(base({ dialog: dialog({ step: 'review', draft: FILLED, busy: true }) })) },
    { id: 'checking', label: 'Many reports from the network: the device check runs first', model: batch(base({ dialog: dialog({ step: 'review', draft: FILLED, busy: true, checking: true }) })) },
    { id: 'refused-wait', label: 'Refused: too many reports from this network, wait (Send held)', model: batch(base({ dialog: dialog({ step: 'review', draft: FILLED, refusal: { key: 'refused.wait', wait: { unit: 'minutes', count: 42 } } }) })) },
    { id: 'refused-off', label: 'Refused: the maker’s privacy notice is not in force (the door closes)', model: batch(base({ door: 'closed', dialog: dialog({ step: 'review', draft: FILLED, refusal: { key: 'refused.off', wait: null } }) })) },
    { id: 'refused-field', label: 'Refused: the API named a field (back on the form)', model: batch(base({ dialog: dialog({ draft: { ...FILLED, email: 'lettore@' }, refusal: { key: 'refused.fields', wait: null }, refusedFields: { email: 'problem.email' } }) })) },
    { id: 'discard', label: 'Close with typed work: Discard or Stay', model: batch(base({ dialog: dialog({ draft: FILLED, discard: true }) })) },
    { id: 'sent', label: 'Sent: the number to quote, our quality team reads it today, the photos', model: batch(base({ dialog: dialog({ draft: FILLED, sent: { number: 'PSR-2026-0007' }, photos: photos() }) })) },
    {
      id: 'sent-photos',
      label: 'Photos: one sent, one sending, one failed (Try again)',
      model: batch(base({ dialog: dialog({ draft: FILLED, sent: { number: 'PSR-2026-0007' }, photos: photos({ photos: [{ key: 'a', name: 'PSR-2026-0007-photo-1.jpg', state: 'sent' }, { key: 'b', name: 'PSR-2026-0007-photo-2.jpg', state: 'sending' }, { key: 'c', name: 'PSR-2026-0007-photo-3.jpg', state: 'failed' }], held: 'photos.held.sending' }) }) })),
    },
    { id: 'photos-over', label: 'The time for photos is over: Add a photo held with why', model: batch(base({ dialog: dialog({ draft: FILLED, sent: { number: 'PSR-2026-0007' }, photos: photos({ held: 'photos.held.over' }) }) })) },
  ],
})
