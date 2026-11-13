import { createElement, useEffect, useState } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import {
  APPOINTMENT,
  APPOINTMENT_DONE,
  canFor,
  CHECK_INSIDE,
  CHECK_OFF,
  CHECK_OUTSIDE,
  COMPANY_ID,
  FITTINGS,
  FITTINGS_EMPTY,
  FITTINGS_OFF,
  inShell,
  ME,
  ME_PERSON,
  NOW,
  PEOPLE,
  PHOTO_SRC,
  PREFIX,
  PROOFS,
  RECORD,
  RECORD_CONFIRMED,
  RECORD_NEW,
  RECORD_OFF,
  RECORD_OUTSIDE,
  RECORD_OWN,
  RECORD_VIEW_ONLY,
  REPEAT,
  REPEAT_OLD,
  RESULT_TO_ALTER,
  REV2,
  REV3,
  SENT,
  SENT_EMPTY,
  STYLE,
  STYLES,
  TODAY,
  type RoleCase,
} from '../demo/fixtures'
import { bookDraftFor, draftFromRevision, formPoints, linkDraftFor, resultDraftFor, reviewDraftFor, type RecordTab } from '../model'
import type { ProfileRecordModel, RecordDialog } from './view-model'
import { ProfileRecordView } from './view/ProfileRecordView'

/**
 * SCR-036-record — the rider profile (design sales.mtm "Record: Rider profile") with made-up data only. Each case is a state the
 * Owner reviews: the Measurements tab (the newest revision waiting for the factory review, confirmed, an older revision read,
 * a value kept outside its range, view only, made-to-measure off for the template), the certified range check (inside, outside,
 * off), Review measurements (confirm, ask for more, held for the measurer and without the right), Compare revisions, New
 * revision, the Photos tab (opened, the deletion day), the Fittings tab (booked, off, empty; Book a fitting; the appointment's
 * panel and its forms; Record outcome; Send to alteration), the Proofs, Orders (Repeat order, old measures) and Activity tabs,
 * Send a measurement link, Use in a new quote, and the record's own states.
 */

interface DesignModel {
  readonly role: RoleCase
  readonly model: ProfileRecordModel
}

const record = (over: Partial<ProfileRecordModel> = {}, role: RoleCase = 'owner'): DesignModel => ({
  role,
  model: {
    prefix: PREFIX,
    me: ME,
    companyId: COMPANY_ID,
    today: TODAY,
    can: canFor(role),
    tab: 'measurements',
    loaded: { status: 'ready', record: RECORD },
    asOf: NOW,
    live: 'live',
    stale: null,
    notice: null,
    revisionId: null,
    range: { styles: { items: STYLES, problem: null }, styleId: STYLE.id, style: STYLE, colourwayId: STYLE.colourways[0]!.id, check: CHECK_INSIDE, checking: false, problem: null },
    fittings: { items: FITTINGS, problem: null },
    sent: { items: SENT, problem: null },
    proofs: { items: PROOFS, problem: null },
    dialog: null,
    measurements: null,
    link: null,
    quote: null,
    ...over,
  },
})
const tab = (name: RecordTab, over: Partial<ProfileRecordModel> = {}, role: RoleCase = 'owner') => record({ tab: name, ...over }, role)
const dialog = (value: RecordDialog, over: Partial<ProfileRecordModel> = {}, role: RoleCase = 'owner') => record({ dialog: value, ...over }, role)
const review = (decision: 'CONFIRM' | 'NEED_MORE', over: Partial<Extract<RecordDialog, { kind: 'review' }>> = {}): RecordDialog => ({ kind: 'review', draft: reviewDraftFor(decision, true), check: null, checking: false, busy: false, notice: null, ...over })
const appointment = (over: Partial<Extract<RecordDialog, { kind: 'appointment' }>> = {}): RecordDialog => ({ kind: 'appointment', id: APPOINTMENT.id, appointment: APPOINTMENT, problem: null, mode: 'view', move: { startsAt: APPOINTMENT.startsAt, minutes: 60, place: APPOINTMENT.place, invite: true }, close: { status: 'DONE', notes: '' }, reason: '', busy: false, notice: null, ...over })

function RecordDesign({ model: design }: { model: DesignModel }) {
  const [model, setModel] = useState(design.model)
  useEffect(() => setModel(design.model), [design])
  const set = (patch: Partial<ProfileRecordModel>) => setModel((now) => ({ ...now, ...patch }))
  const patchDialog = (patch: Record<string, unknown>) => setModel((now) => (now.dialog ? { ...now, dialog: { ...now.dialog, ...patch } as RecordDialog } : now))
  return inShell(
    `/sales/made-to-measure/${RECORD.id}`,
    createElement(ProfileRecordView, {
      model,
      actions: {
        onRevision: (id) => set({ revisionId: id }),
        onDialog: (next) => set({ dialog: next }),
        onReviewDraft: (patch) => setModel((now) => (now.dialog?.kind === 'review' ? { ...now, dialog: { ...now.dialog, draft: { ...now.dialog.draft, ...patch } } } : now)),
        onReview: () => set({ dialog: null, notice: { key: 'review.done.confirmed', tone: 'success' } }),
        onCompare: (patch) => patchDialog(patch),
        onOpenFitting: () => set({ dialog: { kind: 'fitting', draft: bookDraftFor(new Date(NOW)), people: PEOPLE, busy: false, notice: null } }),
        onBookDraft: (patch) => setModel((now) => (now.dialog?.kind === 'fitting' ? { ...now, dialog: { ...now.dialog, draft: { ...now.dialog.draft, ...patch } } } : now)),
        onBook: () => set({ dialog: null, notice: { key: 'book.done.invited', tone: 'success' } }),
        onOpenAppointment: () => set({ dialog: appointment() }),
        onAppointmentMode: (mode) => patchDialog({ mode }),
        onAppointmentDraft: (patch) => patchDialog(patch),
        onOpenOutcome: (id) => set({ dialog: { kind: 'outcome', draft: resultDraftFor(id ?? '', RECORD.units[0]!.lineId), busy: false, notice: null } }),
        onOutcomeDraft: (patch) => setModel((now) => (now.dialog?.kind === 'outcome' ? { ...now, dialog: { ...now.dialog, draft: { ...now.dialog.draft, ...patch } } } : now)),
        onChange: (code, patch) => setModel((now) => (now.dialog?.kind === 'outcome' ? { ...now, dialog: { ...now.dialog, draft: { ...now.dialog.draft, changes: { ...now.dialog.draft.changes, [code]: { ...(now.dialog.draft.changes[code] ?? { change: '', note: '' }), ...patch } } } } } : now)),
        onRecordOutcome: () => set({ dialog: null }),
        onOpenRepeat: () => set({ dialog: { kind: 'repeat', facts: REPEAT, problem: null, fromLineId: REPEAT.earlier[0]!.lineId, measuredOk: false, busy: false, notice: null } }),
        onRepeatDraft: (patch) => patchDialog(patch),
        onOpenPhoto: (revisionId, fileId, view) => set({ dialog: { kind: 'photo', revisionId, fileId, view, src: PHOTO_SRC, problem: null } }),
        onOpenDeleteDay: (revisionId, revision) => set({ dialog: { kind: 'deleteDay', revisionId, revision, day: TODAY, reason: '', busy: false, notice: null } }),
        onDeleteDayDraft: (patch) => patchDialog(patch),
        onNewRevision: () => set({ measurements: revisionDialog() }),
        onOpenLink: () => set({ link: linkDialog() }),
        onOpenQuote: () => set({ quote: { riderName: RECORD.riderName, customer: RECORD.customer.name, revision: 3, styles: { items: STYLES, problem: null }, style: STYLE, draft: { styleId: STYLE.id, colourwayId: STYLE.colourways[0]!.id, baseSize: '' }, check: CHECK_INSIDE, checking: false, busy: false, offline: false, notice: null } }),
        measurements: { onClose: () => set({ measurements: null }), onDiscard: () => set({ measurements: null }), onSave: () => set({ measurements: null }), onValue: (code, value) => setModel((now) => (now.measurements ? { ...now, measurements: { ...now.measurements, draft: { ...now.measurements.draft, values: { ...now.measurements.draft.values, [code]: value } } } } : now)) },
        link: { onClose: () => set({ link: null }), onDraft: (patch) => setModel((now) => (now.link ? { ...now, link: { ...now.link, draft: { ...now.link.draft, ...patch } } } : now)) },
        quote: { onClose: () => set({ quote: null }) },
      },
    }),
    design.role,
  )
}

const revisionDialog = () => ({
  mode: 'revision' as const,
  fixed: { riderName: RECORD.riderName, customer: RECORD.customer.name, garmentType: 'JACKET', revision: 3 },
  template: { id: RECORD.template!.id, code: 'JACKET', name: 'Jacket', rulesOn: true },
  points: formPoints(RECORD.template!.points),
  pointsProblem: null,
  draft: draftFromRevision(REV3, NOW),
  people: PEOPLE,
  me: ME_PERSON,
  problems: {},
  flags: [],
  checking: false,
  styles: STYLES,
  styleId: '',
  suggested: null,
  busy: false,
  offline: false,
  notice: null,
  leaving: false,
})
const linkDialog = () => ({ choices: null, profileId: RECORD.latestId, riderName: RECORD.riderName, garmentType: 'JACKET', hasContact: true, pointCount: 8, draft: linkDraftFor('it' as const), busy: false, offline: false, notice: null, sent: null, copied: false })

export const designScreen = defineDesignScreen<DesignModel>({
  screen: 'SCR-036-record',
  title: 'Rider profile',
  view: RecordDesign,
  cases: [
    { id: 'measurements', label: 'Measurements: revision 3 waiting for the factory review, inside the certified range', model: record(), note: 'The revision Listbox reads older ones; Compare; New revision keeps the old one.' },
    { id: 'measurements-confirmed', label: 'Measurements: confirmed by the pattern maker (the review stays)', model: record({ loaded: { status: 'ready', record: RECORD_CONFIRMED } }) },
    { id: 'measurements-older', label: 'An older revision read (2, sent by the link, "need more")', model: record({ revisionId: REV2.id }) },
    { id: 'measurements-outside', label: 'A value kept outside its plausible range (checked by the measurer)', model: record({ loaded: { status: 'ready', record: RECORD_OUTSIDE } }) },
    { id: 'measurements-off', label: 'Made-to-measure off for JACKET (as built): said with the way to start it; the range check not run', model: record({ loaded: { status: 'ready', record: RECORD_OFF }, range: { styles: { items: STYLES, problem: null }, styleId: STYLE.id, style: STYLE, colourwayId: STYLE.colourways[0]!.id, check: CHECK_OFF, checking: false, problem: null } }) },
    { id: 'measurements-first', label: 'Revision 1 only: Compare held, not used yet', model: record({ loaded: { status: 'ready', record: RECORD_NEW } }) },
    { id: 'measurements-view-only', label: 'Production manager: view only (record held), reviews', model: record({ loaded: { status: 'ready', record: RECORD_VIEW_ONLY } }, 'production') },
    { id: 'range-outside', label: 'Certified range check: outside (a rule broken, chest beyond its limit, the certificate refuses)', model: record({ range: { styles: { items: STYLES, problem: null }, styleId: STYLE.id, style: STYLE, colourwayId: STYLE.colourways[0]!.id, check: CHECK_OUTSIDE, checking: false, problem: null } }) },
    { id: 'range-pick', label: 'Certified range check: no style picked yet', model: record({ range: { styles: { items: STYLES, problem: null }, styleId: '', style: null, colourwayId: '', check: null, checking: false, problem: null } }) },
    { id: 'range-checking', label: 'Certified range check: checking', model: record({ range: { styles: { items: STYLES, problem: null }, styleId: STYLE.id, style: STYLE, colourwayId: STYLE.colourways[0]!.id, check: null, checking: true, problem: null } }) },
    { id: 'range-no-styles', label: 'No MTM style uses this garment type yet', model: record({ range: { styles: { items: [], problem: null }, styleId: '', style: null, colourwayId: '', check: null, checking: false, problem: null } }) },
    { id: 'review-confirm', label: 'Review measurements: Confirm (nothing flagged)', model: dialog(review('CONFIRM', { check: CHECK_INSIDE })) },
    { id: 'review-flagged', label: 'Review measurements: a value outside its range and a broken rule flagged', model: dialog(review('CONFIRM', { check: CHECK_OUTSIDE }), { loaded: { status: 'ready', record: RECORD_OUTSIDE } }) },
    { id: 'review-ask', label: 'Review measurements: Ask for more (the words mailed to the rider)', model: dialog(review('NEED_MORE', { draft: { decision: 'NEED_MORE', note: 'Please measure the sleeve again with the arm bent as on the bike.', notify: true } })) },
    { id: 'review-ask-held', label: 'Ask for more: Send held until the words are typed', model: dialog(review('NEED_MORE')) },
    { id: 'review-own', label: 'The measurer: Confirm held (nobody confirms their own measures), Ask for more open', model: dialog(review('CONFIRM'), { loaded: { status: 'ready', record: RECORD_OWN } }) },
    { id: 'review-off', label: 'Review with made-to-measure off: only the plausible ranges are checked', model: dialog(review('CONFIRM'), { loaded: { status: 'ready', record: RECORD_OFF } }) },
    { id: 'review-no-right', label: 'Sales: the review held (production manager decides)', model: record({}, 'sales') },
    { id: 'compare', label: 'Compare revisions 2 → 3 (differences toned)', model: dialog({ kind: 'compare', beforeId: REV2.id, afterId: REV3.id }) },
    { id: 'revision', label: 'New revision 4 from revision 3 (the old one stays)', model: record({ measurements: revisionDialog() }) },
    { id: 'link', label: 'Send a measurement link for this rider', model: record({ link: linkDialog() }) },
    { id: 'quote', label: 'Use in a new quote', model: record({ quote: { riderName: RECORD.riderName, customer: RECORD.customer.name, revision: 3, styles: { items: STYLES, problem: null }, style: STYLE, draft: { styleId: STYLE.id, colourwayId: STYLE.colourways[0]!.id, baseSize: '' }, check: CHECK_INSIDE, checking: false, busy: false, offline: false, notice: null } }) },
    { id: 'photos', label: 'Photos: front, side and back of revision 2 (one not available), the consent, the links made', model: tab('photos') },
    { id: 'photo-open', label: 'A photo opened (its stripped copy)', model: tab('photos', { dialog: { kind: 'photo', revisionId: REV2.id, fileId: SENT.revisions[0]!.photos[0]!.fileId, view: 'FRONT', src: PHOTO_SRC, problem: null } }) },
    { id: 'photo-delete-day', label: 'Set the deletion day (with why)', model: tab('photos', { dialog: { kind: 'deleteDay', revisionId: REV2.id, revision: 2, day: '2026-12-01', reason: '', busy: false, notice: null } }) },
    { id: 'photos-empty', label: 'Photos: none (Ask for photos by link)', model: tab('photos', { sent: { items: SENT_EMPTY, problem: null } }) },
    { id: 'photos-loading', label: 'Photos: reading', model: tab('photos', { sent: { items: null, problem: null } }) },
    { id: 'photos-error', label: 'Photos: the read failed', model: tab('photos', { sent: { items: null, problem: 'problem.unavailable' } }) },
    { id: 'fittings', label: 'Fittings: one booked, one done with its outcome (alteration, the date moved by its time), one cancelled', model: tab('fittings') },
    { id: 'fittings-to-alter', label: 'An outcome needing an alteration: Send to alteration', model: tab('fittings', { fittings: { items: { ...FITTINGS, results: [RESULT_TO_ALTER] }, problem: null } }) },
    { id: 'fittings-off', label: 'Fittings with made-to-measure off: Book and Record held, said with the way to start it', model: tab('fittings', { loaded: { status: 'ready', record: RECORD_OFF }, fittings: { items: FITTINGS_OFF, problem: null } }) },
    { id: 'fittings-empty', label: 'Fittings: none booked', model: tab('fittings', { fittings: { items: FITTINGS_EMPTY, problem: null } }) },
    { id: 'fittings-loading', label: 'Fittings: reading', model: tab('fittings', { fittings: { items: null, problem: null } }) },
    { id: 'book', label: 'Book a fitting: tomorrow 10:00, an hour, me as fitter, the invite on', model: tab('fittings', { dialog: { kind: 'fitting', draft: { ...bookDraftFor(new Date(NOW)), place: 'Showroom' }, people: PEOPLE, busy: false, notice: null } }) },
    { id: 'book-held', label: 'Book a fitting: held (no place; a dealer’s fitter without a name)', model: tab('fittings', { dialog: { kind: 'fitting', draft: { ...bookDraftFor(new Date(NOW)), fitter: { kind: 'outside' } }, people: PEOPLE, busy: false, notice: null } }) },
    { id: 'appointment', label: 'The appointment’s panel: move, cancel, invite again (done held until it starts)', model: tab('fittings', { dialog: appointment() }) },
    { id: 'appointment-move', label: 'Move the appointment (the update mailed)', model: tab('fittings', { dialog: appointment({ mode: 'move' }) }) },
    { id: 'appointment-cancel', label: 'Cancel the appointment: why (held until typed)', model: tab('fittings', { dialog: appointment({ mode: 'cancel' }) }) },
    { id: 'appointment-done', label: 'A done fitting: only Record outcome', model: tab('fittings', { dialog: appointment({ id: APPOINTMENT_DONE.id, appointment: APPOINTMENT_DONE }) }) },
    { id: 'outcome', label: 'Record outcome: alteration needed, chest +2.0, sleeve +1.5, 5 days', model: tab('fittings', { dialog: { kind: 'outcome', draft: { ...resultDraftFor(APPOINTMENT_DONE.id, RECORD.units[0]!.lineId), verdict: 'ALTER', changes: { chest: { change: '+2.0', note: 'Tight when tucked' }, sleeve: { change: '+1.5', note: '' } }, days: '5' }, busy: false, notice: null } }) },
    { id: 'outcome-bad', label: 'Record outcome: a change that is not a number (said at the point)', model: tab('fittings', { dialog: { kind: 'outcome', draft: { ...resultDraftFor('', RECORD.units[0]!.lineId), verdict: 'ALTER', changes: { chest: { change: 'two', note: '' } } }, busy: false, notice: null } }) },
    { id: 'proofs', label: 'Proofs of the rider’s quote: approved on the link, waiting, being checked', model: tab('proofs') },
    { id: 'proofs-empty', label: 'Proofs: the quotes carry none yet', model: tab('proofs', { proofs: { items: [], problem: null } }) },
    { id: 'proofs-no-quote', label: 'Proofs: no quote yet (Send proof held with why)', model: tab('proofs', { loaded: { status: 'ready', record: RECORD_NEW } }) },
    { id: 'orders', label: 'Orders: the order waiting for the review (rev 3), the quote on rev 2 (a newer revision exists)', model: tab('orders') },
    { id: 'orders-empty', label: 'Orders: not used yet (Use in a new quote; Repeat held)', model: tab('orders', { loaded: { status: 'ready', record: RECORD_NEW } }) },
    { id: 'repeat', label: 'Repeat order from the latest profile: copy a unit on revision 3', model: tab('orders', { dialog: { kind: 'repeat', facts: REPEAT, problem: null, fromLineId: REPEAT.earlier[0]!.lineId, measuredOk: false, busy: false, notice: null } }) },
    { id: 'repeat-old', label: 'Repeat order: measured 14 months ago — held until "order on these measures anyway"', model: tab('orders', { dialog: { kind: 'repeat', facts: REPEAT_OLD, problem: null, fromLineId: REPEAT_OLD.earlier[0]!.lineId, measuredOk: false, busy: false, notice: null } }) },
    { id: 'activity', label: 'Activity: revisions, reviews, the worksheets and the units, newest first', model: tab('activity') },
    { id: 'notice', label: 'A review done: the orders waiting went on', model: record({ notice: { key: 'review.done.confirmedOrders', params: { count: 1, orders: 'SO-DEMO-0003' }, tone: 'success' } }) },
    { id: 'stale', label: 'Changed while working (Read it again)', model: record({ stale: '10:14' }) },
    { id: 'offline', label: 'Offline: the actions held', model: record({ live: 'offline' }) },
    { id: 'loading', label: 'Loading', model: record({ loaded: { status: 'loading' }, asOf: null }) },
    { id: 'error', label: 'The read failed (Try again)', model: record({ loaded: { status: 'error', problem: 'problem.unavailable' } }) },
    { id: 'not-found', label: 'Not found', model: record({ loaded: { status: 'notFound' } }) },
    { id: 'no-permission', label: 'Read only: no access (body data)', model: record({ loaded: { status: 'forbidden' } }, 'reader') },
  ],
})
