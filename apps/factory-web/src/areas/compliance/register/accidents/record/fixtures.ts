import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import { asReadOnly, canOf, CLOSED_REPORT, NEW_REPORT, PREFIX, REPORT, REVISIONS, TODAY } from '../demo/fixtures'
import { dialogFor, toldDialogFor } from './dialogs'
import type { DialogState, RecordDialog, ReportRecordModel } from './view-model'
import { ReportRecordView } from './view/ReportRecordView'

/**
 * SCR-421-record (B-W2b-357) — a product-safety report in the office: Report (serious harm not told; a new public report not
 * seen; the injury opened by quality with the opening recorded, restricted for sales and read-only, not said yet; the
 * reporter hidden), Accident log (to tell, told, not in the log), Photos (one, none, adding), each dialog (close, file,
 * record in the log, a revision, the authority told, erase the reporter, erase the injury words, record whether hurt,
 * correct the facts) with its problems and a refusal, changed elsewhere, a closed report, loading, not found, error, no
 * permission. Made-up data only.
 */

const base = (over: Partial<ReportRecordModel> = {}): ReportRecordModel => ({
  prefix: PREFIX,
  tab: 'report',
  can: canOf('inspector'),
  today: TODAY,
  report: REPORT,
  problem: null,
  revisions: { items: REVISIONS, problem: null },
  injury: { state: 'closed' },
  opening: null,
  photos: { photos: [], max: 6, until: null, held: null, capturing: false, already: REPORT.photos.length },
  dialog: null,
  notice: null,
  live: 'live',
  changed: false,
  ...over,
})

const OPENED = { state: 'open' as const, at: '2026-11-12T09:40:00Z', value: { reportId: REPORT.id, number: REPORT.number, injured: true, consentAt: '2026-11-11T15:02:00Z', words: 'Contusione al ginocchio destro, nessuna frattura (inventato).', erased: null, recordedAt: '2026-11-11T15:02:00Z', recordedById: null } }

const dialog = (value: RecordDialog, over: Partial<DialogState> = {}): DialogState => ({ dialog: value, tried: false, busy: false, problem: null, ...over })

export const designScreen = defineDesignScreen<ReportRecordModel>({
  screen: 'SCR-421-record',
  title: 'Compliance › Product-safety report (the record)',
  view: ReportRecordView,
  cases: [
    { id: 'report', label: 'Report: being assessed, serious harm not told (quality)', model: base(), note: 'The band: Close… as the one primary; ⋯ every other verb held with why. The injury behind a recorded opening.' },
    { id: 'injury-open', label: 'The injury opened by quality: the opening recorded', model: base({ injury: OPENED }), note: 'GDPR art. 9: the words only in this page’s state; Hide; every Show is a new recorded opening.' },
    { id: 'injury-failed', label: 'The injury could not be opened: Try again', model: base({ injury: { state: 'failed' } }) },
    { id: 'sales', label: 'Sales: manages the report, the injury restricted', model: base({ can: canOf('sales'), report: { ...REPORT, injury: { recorded: true, mayOpen: false }, actions: REPORT.actions.map((action) => (['openInjury', 'recordInjury', 'eraseInjury', 'logAccident'].includes(action.action) ? { ...action, allowed: false, held: 'NO_PERMISSION' } : action)) } }) },
    { id: 'read-only', label: 'Read-only: the reporter hidden, every verb held', model: base({ can: canOf('readOnly'), report: asReadOnly(REPORT) }) },
    { id: 'new-public', label: 'A new public report nobody has seen: Mark seen first', model: base({ report: NEW_REPORT, photos: { photos: [], max: 6, until: null, held: null, capturing: false } }) },
    { id: 'injury-unsaid', label: 'A report that does not say whether someone was hurt: Record it…', model: base({ report: { ...REPORT, injury: { recorded: false, mayOpen: true }, actions: REPORT.actions.map((action) => (action.action === 'recordInjury' ? { ...action, allowed: true, held: null } : action.action === 'openInjury' || action.action === 'eraseInjury' ? { ...action, allowed: false, held: 'NO_INJURY' } : action)) } }) },
    { id: 'closed', label: 'A closed report: what quality found; the log and an erasure still may', model: base({ report: CLOSED_REPORT, photos: { photos: [], max: 6, until: null, held: 'held.CLOSED', capturing: false } }) },
    { id: 'accident-to-tell', label: 'Accident log: serious harm, the authority to tell (two revisions)', model: base({ tab: 'accident' }) },
    { id: 'accident-told', label: 'Accident log: the authority was told', model: base({ tab: 'accident', report: CLOSED_REPORT, revisions: { items: [CLOSED_REPORT.accidentLog.newest!], problem: null } }) },
    { id: 'accident-none', label: 'Accident log: not in the log (Record in the accident log…)', model: base({ tab: 'accident', report: { ...REPORT, accident: null, accidentLog: { revisions: 0, newest: null, state: { told: false, mustTell: false, words: '' } } }, revisions: { items: [], problem: null } }) },
    { id: 'accident-loading', label: 'Accident log: the revisions loading', model: base({ tab: 'accident', revisions: { items: null, problem: null } }) },
    { id: 'photos', label: 'Photos: one, Add a photo', model: base({ tab: 'photos' }) },
    { id: 'photos-none', label: 'Photos: none yet', model: base({ tab: 'photos', report: NEW_REPORT, photos: { photos: [], max: 6, until: null, held: null, capturing: false } }) },
    { id: 'photos-adding', label: 'Photos: one sending', model: base({ tab: 'photos', photos: { photos: [{ key: 'x', name: 'PSR-DEMO-0002-photo-2.jpg', state: 'sending' }], max: 6, until: null, held: 'photos.held.sending', capturing: false, already: 1 } }) },
    { id: 'dialog-close', label: 'Close…: the closing words', model: base({ dialog: dialog({ kind: 'close', note: 'Cucitura difettosa su 3 capi del lotto L-2240; lotto bloccato e richiamo valutato (inventato).' }) }) },
    { id: 'dialog-close-empty', label: 'Close… without words: held with why', model: base({ dialog: dialog({ kind: 'close', note: '' }, { tried: true }) }) },
    { id: 'dialog-file', label: 'File in the PPE register…', model: base({ report: NEW_REPORT, dialog: dialog(dialogFor('file', NEW_REPORT)) }) },
    { id: 'dialog-log-first', label: 'Record in the accident log… (the first revision)', model: base({ report: { ...REPORT, accidentLog: { revisions: 0, newest: null, state: { told: false, mustTell: false, words: '' } } }, dialog: dialog({ kind: 'revise', first: true, told: false, draft: { occurredOn: '2026-11-09', place: '', outcome: '', toldOn: '', reference: '', note: '' } }, { tried: true }) }) },
    { id: 'dialog-revise', label: 'Record a revision…: why it corrects the log', model: base({ tab: 'accident', dialog: dialog(dialogFor('revise', REPORT)) }) },
    { id: 'dialog-told', label: 'The authority was told…: the day and the reference', model: base({ tab: 'accident', dialog: dialog({ ...(toldDialogFor(REPORT, TODAY) as Extract<RecordDialog, { kind: 'revise' }>), draft: { ...(toldDialogFor(REPORT, TODAY) as Extract<RecordDialog, { kind: 'revise' }>).draft, reference: 'SBG-DEMO-0099', note: 'Comunicato tramite Safety Business Gateway (inventato).' } }) }) },
    { id: 'dialog-revise-refused', label: 'A revision refused: someone changed the report meanwhile', model: base({ tab: 'accident', dialog: dialog(dialogFor('revise', REPORT), { problem: 'refused.stale' }) }) },
    { id: 'dialog-erase-reporter', label: 'Erase the reporter’s data… (GDPR art. 17)', model: base({ report: NEW_REPORT, dialog: dialog({ kind: 'eraseReporter', reason: '' }, { tried: true }) }) },
    { id: 'dialog-erase-injury', label: 'Erase the injury words…', model: base({ dialog: dialog({ kind: 'eraseInjury', reason: 'Richiesta del cliente via mail del 12/11 (inventato).' }) }) },
    { id: 'dialog-record-injury', label: 'Record whether someone was hurt: yes, the consent, the words', model: base({ dialog: dialog({ kind: 'recordInjury', draft: { injured: true, consent: true, words: 'Taglio superficiale alla mano (inventato).' } }) }) },
    { id: 'dialog-facts', label: 'Correct the facts…', model: base({ dialog: dialog(dialogFor('facts', REPORT)) }) },
    { id: 'changed', label: 'Changed elsewhere while a dialog holds work', model: base({ changed: true, dialog: dialog({ kind: 'close', note: 'Bozza (inventato).' }) }) },
    { id: 'receipt', label: 'A receipt after a write', model: base({ notice: { key: 'receipt.revised', tone: 'success' } }) },
    { id: 'loading', label: 'Loading', model: base({ report: null }) },
    { id: 'not-found', label: 'Not found', model: base({ report: null, problem: 'read.notFound' }) },
    { id: 'error', label: 'The read failed: Try again', model: base({ report: null, problem: 'read.failed' }) },
    { id: 'no-permission', label: 'No permission (warehouse)', model: base({ can: canOf('warehouse'), report: null }) },
  ],
})
