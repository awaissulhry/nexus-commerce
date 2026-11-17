import { createElement, useEffect, useState } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { CaseRecord } from '../api'
import { actionsFor, BUSINESS_CASE, canFor, CLOSED_CASE, CONSUMER_CASE, CONTACTS, CUSTOMERS, inShell, LINK_FOUND, LINKS, MAILS, ME, NOW, PEOPLE, PREFIX, REASONS, recordOf, RIDER_CASE, ROWS, TODAY, type RoleCase } from '../demo/fixtures'
import { caseDraftOf, coverDraftOf, emptyReturnDraft, repairDraftOf, type RecordTab } from '../model'
import type { RecordDialog, ServiceRecordModel } from './view-model'
import { ServiceRecordView } from './view/ServiceRecordView'
// ---- B-TH-259: the case's made-up docked thread (RecordFrame beside every tab) ----
import { designDockedThread } from '../../../_shared/record-frame/fixtures'

/**
 * SCR-413 — a service case (made-up data only): each tab (B-TH-259: Case with its status mails, Warranty check, Linked records &
 * actions; the case's thread docked beside every tab — its customer's only, a rider's case notes only), the band's
 * primary per status, every dialog (a move with the status mail, the cover decided, Link, Unlink, Make repair, Make RMA for a
 * remake), the receipts, the role cases (sales decides; quality follows up without deciding; production reads) and every state
 * of a record (loading, not found, error, no permission, offline, changed elsewhere).
 */

interface DesignModel {
  readonly role: RoleCase
  readonly model: ServiceRecordModel
  readonly record: CaseRecord | null
}

const base = (record: CaseRecord | null, tab: RecordTab = 'case', over: Partial<ServiceRecordModel> = {}, role: RoleCase = 'owner'): DesignModel => ({
  role,
  record,
  model: {
    prefix: PREFIX,
    me: ME,
    today: TODAY,
    can: canFor(role),
    tab,
    loaded: record ? { status: 'ready', record } : { status: 'loading' },
    live: 'live',
    asOf: NOW,
    owners: PEOPLE,
    customers: { items: CUSTOMERS, problem: null },
    contacts: { items: CONTACTS, problem: null },
    draft: null,
    saving: false,
    dialog: null,
    notice: null,
    stale: null,
    busy: false,
    copied: false,
    ...over,
  },
})

const asRole = (record: CaseRecord, role: RoleCase): CaseRecord => ({ ...record, actions: actionsFor(role, record) })
const dialog = (record: CaseRecord, value: RecordDialog, tab: RecordTab = 'case', role: RoleCase = 'owner') => base(record, tab, { dialog: value }, role)
const NEW_CASE = recordOf(ROWS[1]!, { warranty: { ...BUSINESS_CASE.warranty, decided: null }, party: BUSINESS_CASE.party })

function RecordDesign({ model: design }: { model: DesignModel }) {
  const [model, setModel] = useState(design.model)
  useEffect(() => setModel(design.model), [design])
  const record = design.record
  return inShell(
    '/sales/service',
    createElement(ServiceRecordView, {
      model,
      // B-TH-259: the case's thread in its own words; none without threads.read.
      thread: record && model.can.threads ? designDockedThread({ recordType: 'ServiceCase', record: record.number, party: record.party ? { name: record.party.legalName, role: 'customer' } : null }) : null,
      actions: {
        onDraft: (patch) => setModel((now) => ({ ...now, draft: { ...(now.draft ?? (record ? caseDraftOf(record) : caseDraftOf(CONSUMER_CASE))), ...patch } })),
        onDiscard: () => setModel((now) => ({ ...now, draft: null })),
        onDialog: (next) => setModel((now) => ({ ...now, dialog: next })),
        onDialogChange: (patch) => setModel((now) => ({ ...now, dialog: now.dialog ? ({ ...now.dialog, ...patch } as RecordDialog) : null })),
        onSubmitDialog: () => setModel((now) => ({ ...now, dialog: null })),
        onMove: (action) => setModel((now) => ({ ...now, dialog: { kind: 'move', draft: { action, resolution: '', reason: '', message: '' }, busy: false, notice: null } })),
        onFindLinkable: () => setModel((now) => (now.dialog?.kind === 'link' ? { ...now, dialog: { ...now.dialog, found: { items: LINK_FOUND, reading: false, problem: null } } } : now)),
      },
    }),
    design.role,
  )
}

const EDITED = { ...caseDraftOf(CONSUMER_CASE), priority: 'HIGH' as const, problem: `${CONSUMER_CASE.problem}\nThe zip slider is missing too.` }
const linkDialog = (over: Partial<Extract<RecordDialog, { kind: 'link' }>> = {}): RecordDialog => ({ kind: 'link', recordType: 'SalesOrder', q: 'SO-00', found: { items: LINK_FOUND, reading: false, problem: null }, picked: LINK_FOUND[1]!, note: 'The second jacket of the order', busy: false, notice: null, ...over })

export const designScreen = defineDesignScreen<DesignModel>({
  screen: 'SCR-413',
  title: 'Service case',
  view: RecordDesign,
  cases: [
    { id: 'case', label: 'Case: a consumer’s warranty claim (the form, the garment, the internal note); the band asks to decide the cover first', model: base(CONSUMER_CASE) },
    { id: 'case-editing', label: 'Case: two changes waiting — the EditModeBar (⌘S)', model: base(CONSUMER_CASE, 'case', { draft: EDITED }) },
    { id: 'case-held', label: 'Case: Apply held — the status mails need a contact with an e-mail', model: base(CONSUMER_CASE, 'case', { draft: { ...caseDraftOf(CONSUMER_CASE), contactId: CONTACTS[1]!.id, notifyCustomer: true } }) },
    { id: 'case-new', label: 'A NEW case: the band’s primary is Open the case', model: base(NEW_CASE) },
    { id: 'case-rider', label: 'A rider’s question: no customer of ours, a serial not ours', model: base(RIDER_CASE) },
    { id: 'case-closed', label: 'A closed case: only the internal note can change; the resolution and who closed it', model: base(CLOSED_CASE) },
    { id: 'case-production', label: 'Production manager: reads — fields as text, “You can view, not change”', model: base(asRole(CONSUMER_CASE, 'production'), 'case', {}, 'production') },
    { id: 'warranty', label: 'Warranty check: the legal guarantee runs (consumer, first year), not decided yet', model: base(CONSUMER_CASE, 'warranty') },
    { id: 'warranty-decided', label: 'Warranty check: a business customer, the factory guarantee, partly covered (decided)', model: base(BUSINESS_CASE, 'warranty') },
    { id: 'warranty-unknown', label: 'Warranty check: no delivery day — the check cannot tell', model: base(RIDER_CASE, 'warranty') },
    { id: 'warranty-inspector', label: 'Warranty check for a quality inspector: Decide held with why', model: base(asRole(CONSUMER_CASE, 'inspector'), 'warranty', {}, 'inspector') },
    { id: 'decide', label: 'Decide the cover: legal guarantee, covered, why', model: dialog(CONSUMER_CASE, { kind: 'decide', draft: { ...coverDraftOf(CONSUMER_CASE), note: 'A manufacturing defect within the first year.' }, busy: false, notice: null }, 'warranty') },
    { id: 'decide-warnings', label: 'Decide: not covered while the legal guarantee runs (a warning), held until why is said', model: dialog(CONSUMER_CASE, { kind: 'decide', draft: { cover: 'NONE', decision: 'NOT_COVERED', note: '' }, busy: false, notice: null }, 'warranty') },
    { id: 'decide-refused', label: 'Decide refused: covered under a guarantee with no last day', model: dialog(RIDER_CASE, { kind: 'decide', draft: { cover: 'FACTORY_GUARANTEE', decision: 'COVERED', note: 'Goodwill.' }, busy: false, notice: { key: 'problem.fields', tone: 'danger', lines: [{ key: 'field.cover' }] } }, 'warranty') },
    { id: 'linked', label: 'Linked records: the garment’s chain, a repair, the order, an invoice you may not open', model: base({ ...CONSUMER_CASE, links: LINKS }, 'linked') },
    { id: 'linked-empty', label: 'Linked records: nothing yet', model: base(CONSUMER_CASE, 'linked') },
    { id: 'link', label: 'Link a record: an order found by its number, one already linked', model: dialog({ ...CONSUMER_CASE, links: LINKS }, linkDialog(), 'linked') },
    { id: 'unlink', label: 'Unlink the order', model: dialog({ ...CONSUMER_CASE, links: LINKS }, { kind: 'unlink', linkId: LINKS[1]!.id, busy: false, notice: null }, 'linked') },
    { id: 'actions', label: 'Linked records & actions: repair, return, remake, credit — each says what it creates', model: base(CONSUMER_CASE, 'linked') },
    { id: 'actions-rider', label: 'Linked records & actions for a rider’s case: held — name the customer first', model: base(RIDER_CASE, 'linked') },
    { id: 'repair', label: 'Make repair: the case’s problem goes with it', model: dialog(CONSUMER_CASE, { kind: 'repair', draft: repairDraftOf(CONSUMER_CASE), busy: false, notice: null }, 'linked') },
    { id: 'return-remake', label: 'Make RMA for a remake: the reason and the fit', model: dialog(CONSUMER_CASE, { kind: 'return', draft: { ...emptyReturnDraft('REMAKE'), reasonCode: 'WRONG_SIZE' }, reasons: { items: REASONS, problem: null }, busy: false, notice: null }, 'linked') },
    { id: 'return-no-shipment', label: 'Make RMA held: the garment did not leave on a shipment we know', model: dialog(recordOf(ROWS[1]!), { kind: 'return', draft: emptyReturnDraft('RETURN'), reasons: { items: REASONS, problem: null }, busy: false, notice: null }, 'linked') },
    { id: 'made-repair', label: 'Receipt: a repair opened and linked (Open it)', model: base({ ...CONSUMER_CASE, links: LINKS.slice(0, 1) }, 'linked', { notice: { key: 'repair.done', params: { number: 'DEMO-REP-0002' }, tone: 'success', link: { href: `${PREFIX}/sales/returns/repairs/demo`, label: { key: 'repair.open', params: { number: 'DEMO-REP-0002' } } } } }) },
    { id: 'move-resolve', label: 'Resolve: what was done, words for the customer with the status mail', model: dialog(BUSINESS_CASE, { kind: 'move', draft: { action: 'resolve', resolution: 'A new pocket was sewn in.', reason: '', message: 'Your jacket is ready.' }, busy: false, notice: null }) },
    { id: 'move-close', label: 'Close without a resolution: why (held until said); the customer is not told', model: dialog(RIDER_CASE, { kind: 'move', draft: { action: 'close', resolution: '', reason: '', message: '' }, busy: false, notice: null }) },
    { id: 'moved', label: 'Receipt: moved, the customer told by mail', model: base(BUSINESS_CASE, 'case', { notice: { key: 'move.done', params: { number: BUSINESS_CASE.number, status: 'status.RESOLVED' }, tone: 'success', lines: [{ key: 'move.mailSent', params: { to: 'contact@example.com' } }] } }) },
    { id: 'moved-no-mail', label: 'Receipt: moved, no mail went (said, never holding the move)', model: base(BUSINESS_CASE, 'case', { notice: { key: 'move.done', params: { number: BUSINESS_CASE.number, status: 'status.OPEN' }, tone: 'warning', lines: [{ key: 'move.mailNotSent.NO_CONTACT_EMAIL' }] } }) },
    { id: 'refused-cover', label: 'Resolve refused: a warranty claim whose cover is not decided (in words)', model: base(CONSUMER_CASE, 'case', { notice: { key: 'problem.held', tone: 'danger', lines: [{ key: 'held.COVER_UNDECIDED' }] } }) },
    // ---- B-TH-259: Activity is gone — the status mails are on Case (R1-G04), the thread docks beside every tab (R-ACT in its "⋯").
    { id: 'activity', label: 'TH-6 · Case with the status mails sent to the customer; the case’s thread docked beside it', model: base({ ...CONSUMER_CASE, mails: MAILS }, 'case'), note: 'An old ?tab=activity lands here with the thread open; ?tab=actions on Linked records & actions.' },
    { id: 'thread-rider', label: 'TH-6 · A rider’s case: the thread holds office notes only (no customer of ours)', model: base(RIDER_CASE) },
    { id: 'thread-no-right', label: 'TH-6 · Without threads.read: no thread beside the tabs', model: base(CONSUMER_CASE, 'case', { can: { ...canFor('owner'), threads: false } }) },
    { id: 'stale', label: 'Changed elsewhere while editing: read it again', model: base(CONSUMER_CASE, 'case', { draft: EDITED, stale: '10:41' }) },
    { id: 'offline', label: 'Offline: the last copy, every write held', model: base(CONSUMER_CASE, 'case', { live: 'offline', draft: EDITED }) },
    { id: 'loading', label: 'Loading', model: base(null) },
    { id: 'not-found', label: 'Not found', model: { ...base(null), model: { ...base(null).model, loaded: { status: 'notFound' } } } },
    { id: 'error', label: "The API didn't answer (Try again)", model: { ...base(null), model: { ...base(null).model, loaded: { status: 'error', problem: 'problem.unavailable' } } } },
    { id: 'no-permission', label: 'Warehouse: no permission', model: base(null, 'case', { loaded: { status: 'forbidden' } }, 'warehouse') },
  ],
})
