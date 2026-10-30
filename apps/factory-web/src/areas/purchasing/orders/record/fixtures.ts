import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { useT } from '../../../../lib/i18n/provider'
import { samplePdf } from '../../../_shared/document-send/sample-pdf'
import { at, canOf, COLOURS, inShell, MATERIALS, panels, panelsModel, PREFIX, TIME_ZONE, uid, type Role } from '../../../_shared/buying/fixtures'
import { part, PART_LOADING } from '../../../_shared/buying/model'
import type { PoStatus, PurchaseOrder, SendCheckAnswer } from '../api'
import { answerOf, BLOCKED_DRAFT, DOCUMENTS, leatherLine, order, protectorLine, RECEIPTS, withoutPrices } from '../demo/fixtures'
import { reachOf, remindersOf, revisionsDraftTwo, revisionsOne, revisionsTwo, SENT_PAST } from '../demo/daily/fixtures'
import type { DocumentSendModel } from '../../../_shared/document-send/model'
import { sendModelOf, type LineDraft, type OrderRecordModel, type SendCheckState } from '../model'
import { OrderRecordView } from './view/OrderRecordView'

/**
 * SCR-059 — the PO studio (design purchasing.orders "Record: Purchase order", with the shared send dialog SCR-037) with
 * made-up data only: a draft (ready, or held by its checks), the send dialog (checks, the confirm link, what the
 * supplier can do; sending; sent; the mail failed), sent and waiting, the supplier's proposal and the buyer's review
 * (accept / refuse), confirmed by link, partly received with its receipts, received, declined, cancelled; the line
 * dialog (leather specs), remove lines, details, cancel, what the supplier sees; Documents and Activity; and the states.
 * Roles: Owner, Buyer, Planner and Warehouse (no money), Read-only, Sales (none).
 */

export interface RecordCase {
  role: Role
  record: OrderRecordModel
  /** The send dialog's state (the design builds the host's words in the frame's language). */
  send?: { check: SendCheckState; sending?: boolean; problem?: string | null; result?: DocumentSendModel['result']; canSend?: boolean; previewProblem?: string }
}

function recordCase(role: Role, status: PoStatus, over: Partial<OrderRecordModel> = {}, value?: PurchaseOrder): RecordCase {
  const can = canOf(role)
  const base = value ?? order(status)
  const shown = can.cost ? base : withoutPrices(base)
  return {
    role,
    record: {
      prefix: PREFIX,
      can,
      tab: 'lines',
      order: { status: 'ready', value: shown },
      answer: part(answerOf(base)),
      receipts: can.stockView ? part(['PARTLY_RECEIVED', 'RECEIVED'].includes(status) ? RECEIPTS : []) : null,
      documents: part(DOCUMENTS(base)),
      revisions: part(revisionsOne(base)),
      reminders: part(remindersOf(base)),
      now: at(30, 9, 0),
      send: null,
      previewHref: can.cost && status === 'DRAFT' ? '#' : null,
      live: 'live',
      dockOpen: false,
      changed: null,
      notice: null,
      busy: false,
      dialog: null,
      dialogProblem: null,
      panelsPreview: panelsModel('PurchaseOrder', base.id, base.number),
      timeZone: TIME_ZONE,
      today: '2026-10-29',
      ...over,
    },
  }
}

const CHECK: SendCheckAnswer = {
  ready: true,
  checks: [{ code: 'NOT_A_MULTIPLE', severity: 'WARNING', path: 'lines/1/quantity' }],
  recipient: { contactId: uid('6161', 1), name: 'Ufficio ordini Demo', email: 'ordini@conceria-demo.example.com' },
  documentNumber: 'PO-2026-0003',
  language: 'it',
  linkExpiresAt: at(20, 22, 59, 11),
  subject: 'Ordine PO-2026-0003',
}

function RecordDesign({ model }: { model: RecordCase }) {
  const t = useT('buying')
  const value = model.record.order.status === 'ready' ? model.record.order.value : null
  const send =
    model.send && value
      ? sendModelOf(
          {
            order: value,
            check: model.send.check,
            fields: { cc: '', subject: CHECK.subject, message: '' },
            sending: model.send.sending ?? false,
            problem: model.send.problem ?? null,
            result: model.send.result ?? null,
            canSend: model.send.canSend ?? model.record.can.poSend,
            recordHref: `${PREFIX}/purchasing/orders/${value.id}`,
            timeZone: TIME_ZONE,
            preview: !model.record.can.cost
              ? { src: null, openHref: null, problem: t('po.send.previewNeedsCost') }
              : model.send.previewProblem
                ? { src: null, openHref: null, problem: t(model.send.previewProblem) }
                : model.send.check.status === 'ready'
                  ? { src: PDF, openHref: '#', problem: null }
                  : { src: null, openHref: null, problem: null },
          },
          t,
        )
      : null
  return inShell(
    `/purchasing/orders/${value?.id ?? 'x'}`,
    createElement(OrderRecordView, { model: { ...model.record, send }, panels: model.record.tab === 'activity' || model.record.dockOpen ? panels('PurchaseOrder', value?.id ?? 'x', value?.number ?? '') : null }),
    model.role,
  )
}

const lineDraft = (over: Partial<LineDraft> = {}): LineDraft => ({
  lineId: null,
  materialQuery: 'nappa',
  materials: [{ id: MATERIALS.leather.id, code: MATERIALS.leather.code, name: MATERIALS.leather.name, kind: 'LEATHER', tracking: 'HIDE', baseUom: 'FT2', purchaseUom: 'FT2', defaultSupplier: null, requiresCrViTest: true, colourCount: 3, status: 'ACTIVE' }],
  material: {
    id: MATERIALS.leather.id,
    code: MATERIALS.leather.code,
    name: MATERIALS.leather.name,
    kind: 'LEATHER',
    tracking: 'HIDE',
    baseUom: 'FT2',
    purchaseUom: 'FT2',
    defaultSupplier: null,
    requiresCrViTest: true,
    colourCount: 3,
    status: 'ACTIVE',
    colours: [COLOURS.black, COLOURS.red, COLOURS.grey].map((colour) => ({ ...colour, supplierColourCode: null, status: 'ACTIVE' })),
    units: { base: { uom: 'FT2', factor: '1', fixed: true }, purchase: { uom: 'FT2', factor: '1', fixed: true }, consumption: { uom: 'FT2', factor: '1', fixed: true } },
  },
  materialProblem: null,
  itemColourId: COLOURS.red.id,
  quantity: '210',
  uom: 'FT2',
  unitPrice: '4.20',
  needDate: '2026-11-26',
  grade: 'A',
  thicknessMinMm: '1.1',
  thicknessMaxMm: '1.3',
  oneDyeBatch: true,
  areaTolerancePct: '5',
  supplierArticleCode: 'NAP-12',
  supplierColourCode: 'R07',
  note: '',
  ...over,
})

const ready = <T,>(check: T) => ({ status: 'ready' as const, value: check })
const PDF = samplePdf(['Ordine di acquisto PO-2026-0003 - ESEMPIO', 'Officina Demo S.r.l. - documento di prova', 'Conceria Demo S.r.l.', '10  DEMO-LEA-01 Nappa 1,2 mm Nero  420 ft2 (8 pelli)  4,20 = 1.764,00', '    scelta A - 1,1-1,3 mm - un solo bagno - tolleranza 5% - test Cr VI', '20  DEMO-PRT-03 Protezione spalla  24 pz  6,50 = 156,00', 'Totale netto 1.920,00 EUR'])

// ---- B-W2a-69: purchasing every day (Change → revision 2, Revisions, Reminders sent, Close short, Cancel with its reach, Send's confirm-by)

const CONFIRMED_V2 = (): PurchaseOrder => order('CONFIRMED', { revision: 2, documentNumber: 'PO-2026-0003/2', lines: [{ ...leatherLine({ quantity: '560.0000', baseQuantity: '560.0000', netAmount: 235_200 }), confirmedQuantity: '560.0000', confirmedDate: '2026-11-25' }, protectorLine({ ended: { kind: 'CANCELLED', at: at(29, 10, 50), byId: uid('3333', 1), reason: 'From another supplier' } })] })
const DRAFT_V2 = (): PurchaseOrder => order('DRAFT', { revision: 2, documentNumber: 'PO-2026-0003/2', requestedDate: '2026-11-25', lines: [leatherLine({ quantity: '560.0000', baseQuantity: '560.0000', netAmount: 235_200 }), protectorLine()] })
const PARTLY_CLOSED = (): PurchaseOrder => order('RECEIVED', { lines: [{ ...leatherLine({ receivedBaseQuantity: '212.4000', ended: { kind: 'CLOSED_SHORT', at: at(30, 8, 30), byId: uid('3333', 1), reason: 'The tannery has no more of this dye batch' } }), confirmedQuantity: '420.0000', confirmedDate: '2026-11-18' }, { ...protectorLine({ receivedBaseQuantity: '24.0000' }), confirmedQuantity: '24.0000', confirmedDate: '2026-11-18' }] })
const SENT_CHECK = (revision = 1): SendCheckAnswer => ({ ...CHECK, confirmBy: at(31, 10, 0), revision, changes: revision > 1 ? ['Riga 10 (NAP-12 Nappa 1,2 mm): quantità 420 ft² → 560 ft²', 'Riga 20 (Protezione spalla livello 2): annullata', 'Data richiesta: 18/11/2026 → 25/11/2026'] : null })

const DAILY_CASES = [
  { id: 'w2a-frozen-change', label: 'Sent: read-only; Change starts revision 2 (banner on Lines)', model: recordCase('buyer', 'SENT') },
  { id: 'w2a-change', label: 'Change: the order becomes the draft of revision 2; the links stop; sent after', model: recordCase('buyer', 'CONFIRMED', { dialog: { kind: 'change', note: 'Più pelli per l’ordine del cliente.' } }) },
  { id: 'w2a-change-refused', label: 'Change refused: changed meanwhile (read again)', model: recordCase('buyer', 'SENT', { dialog: { kind: 'change', note: '' }, dialogProblem: { key: 'purchasing-orders:refused.changed' } }) },
  { id: 'w2a-change-held', label: 'Change held: goods came (cancel or close a line instead)', model: recordCase('buyer', 'PARTLY_RECEIVED'), note: 'The Lines banner has no Change; ⋯ offers Close short / Cancel line per line.' },
  { id: 'w2a-change-no-right', label: 'Change held for a role without purchasing.send', model: recordCase('planner', 'SENT') },
  { id: 'w2a-revision-draft', label: 'Revision 2 draft — the supplier sees it after you send it (the changes so far)', model: recordCase('buyer', 'DRAFT', { revisions: part(revisionsDraftTwo()) }, DRAFT_V2()) },
  { id: 'w2a-revision-cancel-line', label: 'Revision 2 draft: cancel a line revision 1 sent (reach per line)', model: recordCase('buyer', 'DRAFT', { revisions: part(revisionsDraftTwo()), dialog: { kind: 'endLines', action: 'CANCEL_LINES', lineIds: [protectorLine().id], reason: 'Bought elsewhere', message: '', reach: { status: 'ready', value: reachOf('CANCEL_LINES', DRAFT_V2(), { lines: reachOf('CANCEL_LINES', DRAFT_V2()).lines.filter((line) => line.seq === 20), workOrders: [], salesOrders: [] }) } } }, DRAFT_V2()) },
  { id: 'w2a-send-revision', label: 'Send revision 2: confirm by (default 48 h), what changed, the change note', model: { ...recordCase('buyer', 'DRAFT', { revisions: part(revisionsDraftTwo()), dialog: { kind: 'send' }, sendExtra: { confirmBy: '', changeNote: 'Più pelli per l’ordine del cliente.' }, sendFacts: { confirmBy: at(31, 10, 0), changes: SENT_CHECK(2).changes ?? null } }, DRAFT_V2()), send: { check: ready(SENT_CHECK(2)) } } },
  { id: 'w2a-send-confirm-by', label: 'Send revision 1: confirm by set to a later time', model: { ...recordCase('buyer', 'DRAFT', { dialog: { kind: 'send' }, sendExtra: { confirmBy: at(2, 12, 0, 11), changeNote: '' }, sendFacts: { confirmBy: at(31, 10, 0), changes: null } }), send: { check: ready(SENT_CHECK()) } } },
  { id: 'w2a-revisions', label: 'Confirmations & changes › Revisions: v1, v2 with the diff, the answer, the PDF, the price change (cost grain)', model: recordCase('buyer', 'CONFIRMED', { tab: 'answer', revisions: part(revisionsTwo()), reminders: part(remindersOf(CONFIRMED_V2())) }, CONFIRMED_V2()) },
  { id: 'w2a-revisions-no-cost', label: 'Revisions without the cost grain: no prices, not even as —', model: recordCase('planner', 'CONFIRMED', { tab: 'answer', revisions: part(revisionsTwo()), reminders: part(remindersOf(CONFIRMED_V2())) }, CONFIRMED_V2()) },
  { id: 'w2a-revisions-only-one', label: 'Revisions: only revision 1', model: recordCase('buyer', 'SENT', { tab: 'answer' }, SENT_PAST()) },
  { id: 'w2a-revisions-failed', label: 'Revisions: couldn’t load (Try again; never drawn as empty)', model: recordCase('buyer', 'SENT', { tab: 'answer', revisions: { value: null, problem: 'problem.offline' } }, SENT_PAST()) },
  { id: 'w2a-reminders', label: 'Reminders sent: past the confirm-by, one by hand, the automatic ones off (the Owner’s switch)', model: recordCase('buyer', 'SENT', { tab: 'answer', reminders: part(remindersOf(SENT_PAST())) }, SENT_PAST()) },
  { id: 'w2a-reminders-loading', label: 'Reminders: loading', model: recordCase('buyer', 'SENT', { tab: 'answer', reminders: PART_LOADING }, SENT_PAST()) },
  { id: 'w2a-remind', label: 'Remind the supplier: a mail without the link (FAKE locally)', model: recordCase('buyer', 'SENT', { tab: 'answer', reminders: part(remindersOf(SENT_PAST())), dialog: { kind: 'remind', message: 'Ci serve la conferma entro oggi.' } }, SENT_PAST()) },
  { id: 'w2a-confirm-by', label: 'Move the confirm-by time (nothing goes out; the alert follows it)', model: recordCase('buyer', 'SENT', { tab: 'answer', dialog: { kind: 'confirmBy', confirmBy: at(31, 12, 0) } }, SENT_PAST()) },
  { id: 'w2a-remind-held', label: 'Remind held: a read-only role', model: recordCase('readOnly', 'SENT', { tab: 'answer', reminders: part(remindersOf(SENT_PAST())) }, SENT_PAST()) },
  { id: 'w2a-cancel-confirmed', label: 'Cancel a confirmed order: a contract ends — the supplier is told; WO-0221 and WO-0225 lose their supply', model: recordCase('buyer', 'CONFIRMED', { dialog: { kind: 'cancelOrder', reason: '', message: '', reach: { status: 'ready', value: reachOf('CANCEL_ORDER', order('CONFIRMED')) } } }) },
  { id: 'w2a-cancel-loading', label: 'Cancel: the reach is read first (Cancel PO held)', model: recordCase('buyer', 'SENT', { dialog: { kind: 'cancelOrder', reason: '', message: '', reach: { status: 'loading' } } }) },
  { id: 'w2a-cancel-failed', label: 'Cancel: the reach could not be read (Try again)', model: recordCase('buyer', 'SENT', { dialog: { kind: 'cancelOrder', reason: '', message: '', reach: { status: 'error', problem: 'problem.offline' } } }) },
  { id: 'w2a-cancel-received', label: 'Cancel refused once goods came: close the rest short instead', model: recordCase('buyer', 'PARTLY_RECEIVED', { dialog: { kind: 'cancelOrder', reason: 'x', message: '', reach: { status: 'ready', value: reachOf('CANCEL_ORDER', order('PARTLY_RECEIVED'), { allowed: false, problems: ['(API words are never drawn)'] }) } } }) },
  { id: 'w2a-receipts-close-short', label: 'Receipts › Close short a line: the rest will not come; planning releases it', model: recordCase('buyer', 'PARTLY_RECEIVED', { tab: 'receipts' }) },
  { id: 'w2a-close-short', label: 'Close short: per line received / still expected, the plan line, the work orders it supplied', model: recordCase('buyer', 'PARTLY_RECEIVED', { tab: 'receipts', dialog: { kind: 'endLines', action: 'CLOSE_SHORT', lineIds: [leatherLine().id], reason: 'The tannery has no more of this dye batch', message: '', reach: { status: 'ready', value: reachOf('CLOSE_SHORT', order('PARTLY_RECEIVED')) } } }) },
  { id: 'w2a-closed-short', label: 'A line closed short: received in full, the line marked', model: recordCase('buyer', 'RECEIVED', { tab: 'receipts', notice: { tone: 'success', words: { key: 'purchasing-orders:notice.closedShort', params: { count: 1 } } } }, PARTLY_CLOSED()) },
  { id: 'w2a-line-cancelled', label: 'Lines: a cancelled line stays on the order (not selectable, says why)', model: recordCase('buyer', 'CONFIRMED', { revisions: part(revisionsTwo()) }, CONFIRMED_V2()) },
  { id: 'w2a-counter', label: 'Review proposed changes › Counter-propose: revision 2 from what you asked', model: recordCase('buyer', 'CHANGES_PROPOSED', { dialog: { kind: 'counter', note: 'La data del 25/11 non ci va bene.' } }) },
  { id: 'w2a-review-counter', label: 'Review proposed changes: Accept · Refuse · Counter-propose', model: recordCase('buyer', 'CHANGES_PROPOSED', { dialog: { kind: 'review' } }) },
]

export const designScreen = defineDesignScreen<RecordCase>({
  screen: 'SCR-059',
  title: 'Purchase order studio (lines, send, supplier’s answer, receipts, documents)',
  view: RecordDesign,
  cases: [
    { id: 'draft', label: 'A draft: leather by area with its specs (≈ hides, grade, thickness, one dye batch, tolerance, Cr VI), one warning', model: recordCase('buyer', 'DRAFT') },
    { id: 'draft-held', label: 'A draft held by its checks: a line with no price, a need date past', model: recordCase('buyer', 'DRAFT', {}, BLOCKED_DRAFT()), note: 'Send says how many checks are open; the Lines tab carries a dot.' },
    { id: 'send', label: 'Send to the supplier: the shared dialog with the confirm link and the checks', model: { ...recordCase('buyer', 'DRAFT', { dialog: { kind: 'send' } }), send: { check: ready(CHECK) } } },
    { id: 'send-letterhead', label: 'Send: the PDF cannot be made yet (the letterhead misses a legal detail)', model: { ...recordCase('buyer', 'DRAFT', { dialog: { kind: 'send' } }), send: { check: ready(CHECK), previewProblem: 'po.send.previewNeeds' } } },
    { id: 'send-checking', label: 'Send: checks still running', model: { ...recordCase('buyer', 'DRAFT', { dialog: { kind: 'send' } }), send: { check: { status: 'loading' } } } },
    {
      id: 'send-blocked',
      label: 'Send held by a blocking check, with its Fix link',
      model: { ...recordCase('buyer', 'DRAFT', { dialog: { kind: 'send' } }, BLOCKED_DRAFT()), send: { check: ready({ ...CHECK, ready: false, checks: [{ code: 'LINE_NOT_PRICED', severity: 'BLOCKS', path: 'lines/0/unitPrice' }, { code: 'NO_CONTACT_EMAIL', severity: 'BLOCKS', path: 'contactId' }] }) } },
    },
    { id: 'send-sending', label: 'Sending', model: { ...recordCase('buyer', 'DRAFT', { dialog: { kind: 'send' } }), send: { check: ready(CHECK), sending: true } } },
    { id: 'sent', label: 'Sent: to whom, when, how long the link lives', model: { ...recordCase('buyer', 'SENT', { dialog: { kind: 'send' } }), send: { check: ready(CHECK), result: { delivery: 'sent', to: 'ordini@conceria-demo.example.com', at: at(29, 10, 42), linkUntil: at(20, 22, 59, 11) } } } },
    { id: 'send-failed', label: 'The mail failed: frozen and stored — Send a new link', model: { ...recordCase('buyer', 'SENT', { dialog: { kind: 'send' } }), send: { check: ready(CHECK), result: { delivery: 'failed', to: 'ordini@conceria-demo.example.com', at: at(29, 10, 42), linkUntil: at(20, 22, 59, 11) } } } },
    { id: 'waiting', label: 'Sent: waiting for the supplier, the link open until 20 Nov', model: recordCase('buyer', 'SENT') },
    { id: 'answer-waiting', label: 'Supplier’s answer: waiting (Send a new link)', model: recordCase('buyer', 'SENT', { tab: 'answer' }) },
    { id: 'proposed', label: 'Changes proposed: the banner, the dot on the answer', model: recordCase('buyer', 'CHANGES_PROPOSED') },
    { id: 'answer-proposed', label: 'Supplier’s answer: asked → proposed per line (two deliveries, later), their reason', model: recordCase('buyer', 'CHANGES_PROPOSED', { tab: 'answer' }) },
    { id: 'review', label: 'Review proposed changes: what accepting or refusing does', model: recordCase('buyer', 'CHANGES_PROPOSED', { dialog: { kind: 'review' } }) },
    { id: 'accept', label: 'Accept: a message for the supplier', model: recordCase('buyer', 'CHANGES_PROPOSED', { dialog: { kind: 'accept', message: 'Va bene, grazie.' } }) },
    { id: 'refuse', label: 'Refuse: a note (then send a new link or cancel)', model: recordCase('buyer', 'CHANGES_PROPOSED', { dialog: { kind: 'refuse', note: '' } }) },
    { id: 'confirmed', label: 'Confirmed by link by a typed name: Receive goods', model: recordCase('buyer', 'CONFIRMED') },
    { id: 'answer-confirmed', label: 'Supplier’s answer: confirmed as asked, their reference and note, the link’s evidence', model: recordCase('buyer', 'CONFIRMED', { tab: 'answer' }) },
    { id: 'partly', label: 'Partly received: received per line', model: recordCase('buyer', 'PARTLY_RECEIVED') },
    { id: 'receipts', label: 'Receipts against the order', model: recordCase('buyer', 'PARTLY_RECEIVED', { tab: 'receipts' }) },
    { id: 'received', label: 'Received in full', model: recordCase('buyer', 'RECEIVED') },
    { id: 'declined', label: 'Declined by the supplier', model: recordCase('buyer', 'DECLINED', { tab: 'answer' }) },
    { id: 'cancelled', label: 'Cancelled, with its reason', model: recordCase('buyer', 'CANCELLED') },
    { id: 'add-line', label: 'Add a line: material, colour, quantity and unit, need date, price, the leather specs', model: recordCase('buyer', 'DRAFT', { dialog: { kind: 'line', draft: lineDraft() } }) },
    { id: 'edit-line', label: 'Change a line: refused (shown inside the dialog)', model: recordCase('buyer', 'DRAFT', { dialog: { kind: 'line', draft: lineDraft({ lineId: leatherLine().id, quantity: '0' }) }, dialogProblem: { key: 'po.lineForm.badQuantity' } }) },
    { id: 'remove-lines', label: 'Remove lines: one came from the plan', model: recordCase('buyer', 'DRAFT', { dialog: { kind: 'removeLines', lineIds: [leatherLine().id] } }) },
    { id: 'details', label: 'Edit details: requested date, Incoterms, payment terms, notes', model: recordCase('buyer', 'DRAFT', { dialog: { kind: 'details', draft: { requestedDate: '2026-11-18', incoterms: 'EXW Santa Croce (demo)', paymentTerms: 'Bonifico 60 gg fm', note: '', internalNote: '' } } }) },
    { id: 'cancel', label: 'Cancel a sent order: its reach (lines, plan, work and sales orders), the reason, the supplier is told', model: recordCase('buyer', 'SENT', { dialog: { kind: 'cancelOrder', reason: 'Bought with the next season’s order', message: '', reach: { status: 'ready', value: reachOf('CANCEL_ORDER', order('SENT')) } } }) },
    ...DAILY_CASES,
    { id: 'new-link', label: 'Send a new link', model: recordCase('buyer', 'SENT', { dialog: { kind: 'newLink', message: '' } }) },
    { id: 'supplier-view', label: 'What the supplier sees: the link page as a copy, no price', model: recordCase('buyer', 'SENT', { dialog: { kind: 'supplierView', view: { status: 'ready', value: { order: { number: 'PO-2026-0003', documentNumber: 'PO-2026-0003', status: 'SENT', orderDate: '2026-10-27', requestedDate: '2026-11-18', note: null }, lines: order('SENT').lines.map((line) => ({ id: line.id, seq: line.seq, code: line.supplierArticleCode ?? line.item.code, name: line.item.name, colour: line.colour ? { name: line.colour.name, supplierCode: line.supplierColourCode } : null, quantity: line.quantity, uom: line.uom, baseQuantity: line.baseQuantity, baseUom: line.baseUom, needDate: line.needDate, grade: line.grade, thicknessMinMm: line.thicknessMinMm, thicknessMaxMm: line.thicknessMaxMm, oneDyeBatch: line.oneDyeBatch, areaTolerancePct: line.areaTolerancePct, estimatedHides: line.estimatedHides, requiresCrViTest: line.requiresCrViTest, confirmedQuantity: null, confirmedDate: null })) } } } }) },
    { id: 'documents', label: 'Documents: the frozen PDF, the mails', model: recordCase('buyer', 'CONFIRMED', { tab: 'documents' }) },
    { id: 'documents-draft', label: 'Documents of a draft: the PDF is made when it is sent', model: recordCase('buyer', 'DRAFT', { tab: 'documents' }) },
    { id: 'activity', label: 'Activity: the thread, files and history', model: recordCase('buyer', 'SENT', { tab: 'activity' }) },
    { id: 'dock', label: 'The thread beside a tab (⌘J, 1280 px and wider)', model: recordCase('buyer', 'SENT', { dockOpen: true }) },
    { id: 'changed', label: 'Changed by someone else while a dialog is open: Reload', model: recordCase('buyer', 'DRAFT', { changed: { at: at(29, 9, 42) }, dialog: { kind: 'details', draft: { requestedDate: '', incoterms: '', paymentTerms: '', note: '', internalNote: 'checking' } } }) },
    { id: 'notice', label: 'After a write: a notice', model: recordCase('buyer', 'CONFIRMED', { notice: { tone: 'success', words: { key: 'po.notice.accepted' } } }) },
    { id: 'part-failed', label: 'A part failed (the answer): in words, with Try again', model: recordCase('buyer', 'SENT', { tab: 'answer', answer: { value: null, problem: 'problem.offline' } }) },
    { id: 'part-loading', label: 'A part still loading (documents)', model: recordCase('buyer', 'SENT', { tab: 'documents', documents: PART_LOADING }) },
    { id: 'owner', label: 'Owner: everything', model: recordCase('owner', 'SENT') },
    { id: 'planner', label: 'Planner: reads the order without a price, writes nothing', model: recordCase('planner', 'CONFIRMED') },
    { id: 'warehouse', label: 'Warehouse: no price, Receive goods', model: recordCase('warehouse', 'CONFIRMED') },
    { id: 'read-only', label: 'Read-only: a draft, Send held with its reason', model: recordCase('readOnly', 'DRAFT') },
    { id: 'loading', label: 'Loading', model: recordCase('buyer', 'DRAFT', { order: { status: 'loading' } }) },
    { id: 'error', label: 'The read failed', model: recordCase('buyer', 'DRAFT', { order: { status: 'error', problem: 'problem.offline' } }) },
    { id: 'not-found', label: 'Not found (or another company)', model: recordCase('buyer', 'DRAFT', { order: { status: 'not_found' } }) },
    { id: 'no-permission', label: 'Sales: no purchasing.view', model: recordCase('sales', 'DRAFT', { order: { status: 'forbidden' } }) },
  ],
})

