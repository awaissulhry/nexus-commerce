import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { Locale } from '../../../../lib/i18n/locales'
import type { ComplaintRecord, ReturnRecord } from '../api'
import { complaintBandOf, returnBandOf } from '../band'
import { at, complaintRecord, PREFIX, returnRecord, returnWords, shellOf, threadOf, words } from '../design-data'
import { cancelHeld, photosHeld, type RecordTab } from '../model'
import type { CaseDialog, CaseRecordViewModel } from '../view/CaseRecordView'
import { ReturnsCase, type ReturnsCaseBuilder } from '../view/ReturnsCase'

/**
 * SCR-187 › one case (design portal.customer.returns rec "Return": Request, Status, Messages; a complaint opens the same
 * tabs; pop:cancel-case; tab:return-label; tab:credit-note; B-W2b-197), MADE-UP data only: a return at each step
 * (requested, approved — print the label, back with us, inspected, closed with a credit note and a replacement, not
 * accepted, cancelled), its Request (what you asked, each item with its photos), its Messages, Cancel this request?
 * (asked, refused), Add photos (picked, refused files, sending, sent), a photo full size; a complaint (being investigated
 * with the 8D steps, answered with our letter and the 8D report, as a buyer who does not follow the investigation, its
 * Request); a colleague who may only read, an office preview, no connection, loading, a failed read and a case that is not
 * theirs.
 */

const WHO = { preview: false, mayRequest: true, offline: false, mayUpload: true }
const LABEL = `/api/portal/returns/x/instructions?language=`

function returnModel(record: ReturnRecord, locale: Locale, over: Partial<CaseRecordViewModel> = {}, who = WHO): CaseRecordViewModel {
  const t = words(locale)
  const held = photosHeld('RETURN', record, who)
  return {
    state: 'ready',
    case: { type: 'RETURN', record },
    tab: 'status',
    prefix: PREFIX,
    offlineSince: null,
    notice: null,
    photosHeld: held ? t(held) : null,
    fileHeld: who.preview ? t('held.previewFiles') : who.offline ? t('held.offline') : null,
    labelHref: record.progress.instructions ? `${LABEL}${locale}` : null,
    creditHeld: null,
    readsComplaints: true,
    dialog: null,
    ...over,
  }
}

function returnCase(build: (locale: Locale) => { record: ReturnRecord; tab?: RecordTab; over?: Partial<CaseRecordViewModel>; who?: typeof WHO; preview?: boolean }): ReturnsCaseBuilder {
  return (locale) => {
    const input = build(locale)
    const tab = input.tab ?? 'status'
    const who = input.who ?? WHO
    const model = returnModel(input.record, locale, { tab, ...input.over }, who)
    const band = returnBandOf({
      words: returnWords(locale),
      record: input.record,
      tab,
      prefix: PREFIX,
      facts: {
        photosHeld: photosHeld('RETURN', input.record, who),
        cancelHeld: cancelHeld(input.record, who),
        labelHref: model.labelHref,
        creditNotes: input.record.progress.creditNotes.map((note) => ({ id: note.id, label: note.number ?? '—' })),
      },
    })
    return { shell: shellOf(locale, band, { path: '/returns', preview: input.preview ?? false }), body: { kind: 'record', model, thread: tab === 'messages' ? threadOf(locale) : null } }
  }
}

function complaintCase(build: (locale: Locale) => { record: ComplaintRecord; tab?: RecordTab; over?: Partial<CaseRecordViewModel>; who?: typeof WHO }): ReturnsCaseBuilder {
  return (locale) => {
    const input = build(locale)
    const t = words(locale)
    const tab = input.tab ?? 'status'
    const who = input.who ?? WHO
    const held = photosHeld('COMPLAINT', input.record, who)
    const model: CaseRecordViewModel = {
      state: 'ready',
      case: { type: 'COMPLAINT', record: input.record },
      tab,
      prefix: PREFIX,
      offlineSince: null,
      notice: null,
      photosHeld: held ? t(held) : null,
      fileHeld: null,
      labelHref: null,
      creditHeld: null,
      readsComplaints: input.record.investigation !== null,
      dialog: null,
      ...input.over,
    }
    return {
      shell: shellOf(locale, complaintBandOf({ words: returnWords(locale), record: input.record, tab, prefix: PREFIX, photosHeld: held })),
      body: { kind: 'record', model, thread: tab === 'messages' ? threadOf(locale) : null },
    }
  }
}

const withDialog = (dialog: CaseDialog) => ({ dialog })
const approved = () => returnRecord('AUTHORISED')
const photos = (record: ReturnRecord) => record.request.lines[0]!.photos

export const designScreen = defineDesignScreen<ReturnsCaseBuilder>({
  screen: 'SCR-187-record',
  title: 'Customer Returns & claims — one case (portal.customer.returns rec Return)',
  view: ReturnsCase,
  cases: [
    { id: 'approved', label: 'Status › approved: print the label and send it back', model: returnCase(() => ({ record: approved() })), note: 'Asked · Decided · Back with us · Inspected · Outcome with their days; “Next step for you”; our decision in words; the return label and instructions (tab:return-label opens the PDF in a new tab); the band’s primary is “Print the return label”.' },
    { id: 'requested', label: 'Status › requested: we decide', model: returnCase(() => ({ record: returnRecord('REQUESTED') })), note: 'We answer by the day the API names; Add photos is the band’s primary.' },
    { id: 'received', label: 'Status › back with us', model: returnCase(() => ({ record: returnRecord('RECEIVED') })), note: 'The parcel we received (carrier, tracking number); Cancel is held: the goods are with us.' },
    { id: 'inspected', label: 'Status › inspected', model: returnCase(() => ({ record: returnRecord('INSPECTED') })), note: 'The inspection per item: pieces received, the condition and what happens, in customer words (never the cause found).' },
    { id: 'closed', label: 'Status › closed: a credit note and a replacement', model: returnCase(() => ({ record: returnRecord('CLOSED') })), note: 'The credit note by its number (no amount) opens its PDF in a new tab (tab:credit-note, through the customer documents); the replacement order links to the order.' },
    { id: 'rejected', label: 'Status › not accepted', model: returnCase(() => ({ record: returnRecord('REJECTED') })), note: 'The office’s reason the customer reads; the remaining steps skipped.' },
    { id: 'cancelled', label: 'Status › cancelled', model: returnCase(() => ({ record: returnRecord('CANCELLED') })) },
    { id: 'request', label: 'Request › what you asked', model: returnCase(() => ({ record: approved(), tab: 'request' })), note: 'Opened, asked in the portal, what you would like, your reference and note; each item with its pieces, size, serial, reason and photos; the request’s photos; Add photos while we have not decided.' },
    { id: 'request-decided', label: 'Request › decided (photos stay as they are)', model: returnCase(() => ({ record: returnRecord('INSPECTED'), tab: 'request' })) },
    { id: 'messages', label: 'Messages', model: returnCase(() => ({ record: approved(), tab: 'messages' })), note: 'The return’s shared thread (PartnerThread): our messages and theirs; “You can also answer our e-mails”.' },
    { id: 'cancel', label: 'pop:cancel-case — Cancel this request?', model: returnCase(() => ({ record: approved(), over: withDialog({ kind: 'cancel', model: { number: 'R-2026-0031', busy: false, problem: null } }) })), note: '“We will close R-2026-0031. You can start a new one any time.” — Cancel request (DS ActionConfirm).' },
    { id: 'cancel-refused', label: 'Cancel refused (the goods reached us meanwhile)', model: returnCase(() => ({ record: approved(), over: withDialog({ kind: 'cancel', model: { number: 'R-2026-0031', busy: false, problem: 'problem.changed' } }) })) },
    { id: 'cancelled-notice', label: 'Cancelled: the notice', model: returnCase(() => ({ record: returnRecord('CANCELLED'), over: { notice: { tone: 'success', key: 'notice.cancelled', params: { number: 'R-2026-0031' } } } })) },
    {
      id: 'photos',
      label: 'Add photos — picked',
      model: returnCase((locale) => ({
        record: approved(),
        tab: 'request',
        over: withDialog({
          kind: 'photos',
          model: {
            number: 'R-2026-0031',
            targets: [
              { id: null, label: words(locale)('photos.ofRequest'), count: 1 },
              { id: 'l1', label: words(locale)('request.line', { seq: 1, description: 'JKT-DEMO-01 Giacca Demo Touring' }), count: 2 },
            ],
            target: 'l1',
            picked: [
              { id: 'p1', name: 'cerniera-3.jpg', type: 'image/jpeg', size: 2_100_000, state: 'waiting', problem: null },
              { id: 'p2', name: 'scontrino.pdf', type: 'application/pdf', size: 120_000, state: 'waiting', problem: 'photos.problem.type' },
            ],
            left: 7,
            held: null,
            busy: false,
            done: null,
          },
        }),
      })),
      note: 'Of the request or one item; JPEG, PNG, WebP or HEIC up to 15 MB, 10 per record; a file we cannot take says why at its row.',
    },
    {
      id: 'photos-sending',
      label: 'Add photos — sending',
      model: returnCase((locale) => ({
        record: approved(),
        tab: 'request',
        over: withDialog({
          kind: 'photos',
          model: {
            number: 'R-2026-0031',
            targets: [{ id: null, label: words(locale)('photos.ofRequest'), count: 1 }],
            target: null,
            picked: [
              { id: 'p1', name: 'cerniera-3.jpg', type: 'image/jpeg', size: 2_100_000, state: 'sent', problem: null },
              { id: 'p3', name: 'etichetta.jpg', type: 'image/jpeg', size: 900_000, state: 'sending', problem: null },
            ],
            left: 7,
            held: 'held.busy',
            busy: true,
            done: null,
          },
        }),
      })),
    },
    {
      id: 'photos-sent',
      label: 'Add photos — sent',
      model: returnCase((locale) => ({
        record: approved(),
        tab: 'request',
        over: withDialog({ kind: 'photos', model: { number: 'R-2026-0031', targets: [{ id: null, label: words(locale)('photos.ofRequest'), count: 3 }], target: null, picked: [{ id: 'p1', name: 'cerniera-3.jpg', type: 'image/jpeg', size: 2_100_000, state: 'sent', problem: null }], left: 7, held: 'photos.held.none', busy: false, done: 1 } }),
      })),
    },
    {
      id: 'photo',
      label: 'A photo full size',
      model: returnCase(() => {
        const record = approved()
        return { record, tab: 'request', over: withDialog({ kind: 'photo', model: { photos: photos(record).map((photo) => ({ id: photo.id, name: photo.name })), index: 0, state: 'error', src: null } }) }
      }),
      note: 'One at a time, Previous / Next held at the ends with the reason, ← →; the made-up photo cannot be read here, so it says so with Try again.',
    },
    { id: 'complaint', label: 'Complaint › being investigated (Quality role)', model: complaintCase(() => ({ record: complaintRecord('INVESTIGATING') })), note: 'Received · Being investigated · Answered · Closed; the 8D steps D1–D8 with their days (read-only); no letter yet.' },
    { id: 'complaint-answered', label: 'Complaint › answered: our letter and the 8D', model: complaintCase(() => ({ record: complaintRecord('ANSWERED') })), note: '“We answered: read our letter.” — the answer letter and the 8D report open in a new tab (each open logged).' },
    { id: 'complaint-buyer', label: 'Complaint › a buyer (status only)', model: complaintCase(() => ({ record: complaintRecord('INVESTIGATING', { investigation: null }) })), note: 'The investigation and our letter are for the customer’s quality contact.' },
    { id: 'complaint-request', label: 'Complaint › what you reported', model: complaintCase(() => ({ record: complaintRecord('INVESTIGATING'), tab: 'request' })) },
    { id: 'complaint-messages', label: 'Complaint › Messages', model: complaintCase(() => ({ record: complaintRecord('INVESTIGATING'), tab: 'messages' })) },
    {
      id: 'viewer',
      label: 'A colleague who may only read',
      model: returnCase(() => ({ record: approved(), tab: 'request', who: { ...WHO, mayRequest: false, mayUpload: false } })),
      note: 'Add photos and Cancel are held and say why; the label still prints.',
    },
    { id: 'preview', label: 'An office preview', model: returnCase(() => ({ record: approved(), who: { ...WHO, preview: true }, preview: true })), note: 'Reads only: every act and every file open is held with the reason.' },
    { id: 'offline', label: 'No connection', model: returnCase(() => ({ record: approved(), who: { ...WHO, offline: true }, over: { offlineSince: at(-1) } })) },
    { id: 'loading', label: 'Loading', model: returnCase(() => ({ record: approved(), over: { state: 'loading', case: null } })) },
    { id: 'error', label: 'The case could not be read', model: returnCase(() => ({ record: approved(), over: { state: 'error', case: null } })) },
    { id: 'missing', label: 'Not theirs, or gone', model: returnCase(() => ({ record: approved(), over: { state: 'missing', case: null } })), note: 'A case of another customer answers as one that does not exist.' },
  ],
})
