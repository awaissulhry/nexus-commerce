import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { useT } from '../../../../lib/i18n/provider'
import { samplePdf } from '../../../_shared/document-send/sample-pdf'
import { at, canOf, COLOURS, inShell, MATERIALS, panels, panelsModel, PREFIX, ROLES, TIME_ZONE, uid, type Role } from '../../../_shared/buying/fixtures'
import { part, PART_LOADING } from '../../../_shared/buying/model'
import type { PoStatus, PurchaseOrder, SendCheckAnswer } from '../api'
import { answerOf, BLOCKED_DRAFT, DOCUMENTS, leatherLine, order, protectorLine, RECEIPTS, withoutPrices } from '../demo/fixtures'
import { reachOf, remindersOf, revisionsDraftTwo, revisionsOne, revisionsTwo, SENT_PAST } from '../demo/daily/fixtures'
import type { DocumentSendModel } from '../../../_shared/document-send/model'
import { sendModelOf, type LineDraft, type OrderRecordModel, type SendCheckState } from '../model'
import { OrderRecordView } from './view/OrderRecordView'
import { WithMessages } from '../../../../record-panels/i18n'
// B-W2b-333: purchase orders in depth on screen (made-up depth data).
import { approvalOf, chaseModel, chaseOf, complianceOf, depthModel, depthOf, depthOrder, kindsOf, liningLine, REQUEST } from '../depth/demo/fixtures'
import { DEPTH, kindDraftOf, scheduleDraftOf, type OrderDepthModel } from '../depth/model'

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
  return createElement(WithMessages, { namespaces: ['buying', DEPTH] }, createElement(RecordDesignInner, { model }))
}

function RecordDesignInner({ model }: { model: RecordCase }) {
  const t = useT('buying')
  const tw = useT(DEPTH)
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
            depthWords: (key) => tw(key),
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

// ---- B-W2b-333: purchase orders in depth on screen ---------------------------------------------------------------------------

/** A depth case: the order (with its lining line by rolls), the role's rights, the depth parts. */
function depthCase(role: Role, value: PurchaseOrder, over: Partial<OrderRecordModel> = {}, depthOver: Partial<OrderDepthModel> = {}, parts: Parameters<typeof depthModel>[3] = {}, extra: readonly string[] = []): RecordCase {
  const shownValue = canOf(role).cost ? value : withoutPrices(value)
  return recordCase(role, value.status, { depth: depthModel(shownValue, [...ROLES[role], ...extra], depthOver, parts), ...over }, value)
}
const DRAFT_D = (): PurchaseOrder => depthOrder(order('DRAFT'))
const SENT_D = (): PurchaseOrder => depthOrder(order('CONFIRMED', { version: 6 }))
const PARTLY_D = (): PurchaseOrder => depthOrder(order('PARTLY_RECEIVED'), [...order('PARTLY_RECEIVED').lines.map((line) => (line.item.kind === 'LEATHER' ? { ...line, receivedBaseQuantity: '440.0000' } : line)), liningLine({ confirmedQuantity: '150.0000', confirmedDate: '2026-11-18', receivedBaseQuantity: '96.0000' })])
const USD_D = (): PurchaseOrder => depthOrder(order('DRAFT', { currency: 'USD', netAmount: 250_000 }))
const HELD_D = (): PurchaseOrder => ({ ...DRAFT_D(), send: { ready: true, checks: [] } })
const held = (request: Parameters<typeof complianceOf>[2] = null, may: Parameters<typeof complianceOf>[3] = {}) => part(complianceOf(HELD_D(), 'held', request, may))
const DECIDER = ['purchasing.compliance.override']
const SEND_DOCS = (blocked: boolean): SendCheckAnswer => ({ ...CHECK, ready: !blocked, checks: blocked ? [{ code: 'COMPLIANCE_DOCUMENT_MISSING', severity: 'BLOCKS', path: 'lines/0' }] : [{ code: 'NOT_A_MULTIPLE', severity: 'WARNING', path: 'lines/1/quantity' }] })
const lining = () => kindsOf(DRAFT_D()).lines.find((line) => line.buysAs === 'FABRIC')!
const protector = () => kindsOf(DRAFT_D()).lines.find((line) => line.buysAs === 'PROTECTOR')!
const leatherDepth = () => depthOf(DRAFT_D()).lines.find((line) => line.itemCode === MATERIALS.leather.code)!

const DEPTH_CASES = [
  { id: 'w2b-333-lines', label: 'Lines in depth: fabric by rolls, the protector’s certificate, For orders (what each line blocks if late), totals', model: depthCase('buyer', DRAFT_D()) },
  { id: 'w2b-333-held', label: 'Held compliance mark: the chromium VI test report expired — this PO can’t be sent; Send without a valid document…', model: depthCase('buyer', HELD_D(), {}, {}, { compliance: held() }), note: 'Send in the band is held by the same check; the line carries a Held tag.' },
  { id: 'w2b-333-override', label: 'Send without a valid document?: which document, which lines, why it matters, the reason; a second person approves', model: depthCase('buyer', HELD_D(), {}, { dialog: { kind: 'override', reason: 'Il rapporto nuovo arriva lunedì dal laboratorio (demo).' } }, { compliance: held() }) },
  { id: 'w2b-333-override-short', label: 'Send without a valid document?: held until the reason says why', model: depthCase('buyer', HELD_D(), {}, { dialog: { kind: 'override', reason: 'ok' } }, { compliance: held() }) },
  { id: 'w2b-333-override-waiting', label: 'The request waits for a second person (asked by me): Take the request back', model: depthCase('buyer', HELD_D(), {}, {}, { compliance: held(REQUEST(), { withdraw: true }) }) },
  { id: 'w2b-333-decide', label: 'A second person (purchasing.compliance.override) decides: Decide… — yes asks a code, no asks why', model: depthCase('owner', HELD_D(), {}, { dialog: { kind: 'decide', decision: 'APPROVED', words: '' } }, { compliance: held(REQUEST({ askedBy: { id: uid('3333', 1), name: 'Anna Demo', me: false } }), { decide: true }) }, DECIDER) },
  { id: 'w2b-333-decide-no', label: 'Decide: no needs words (the person who asked reads them)', model: depthCase('owner', HELD_D(), {}, { dialog: { kind: 'decide', decision: 'REJECTED', words: '' } }, { compliance: held(REQUEST({ askedBy: { id: uid('3333', 1), name: 'Anna Demo', me: false } }), { decide: true }) }, DECIDER) },
  { id: 'w2b-333-decide-code', label: 'Decide yes: the authenticator code (step-up)', model: depthCase('owner', HELD_D(), {}, { stepUp: { open: true, busy: false, sentence: `${DEPTH}:stepUp.decide`, problem: null } }, { compliance: held(REQUEST({ askedBy: { id: uid('3333', 1), name: 'Anna Demo', me: false } }), { decide: true }) }, DECIDER) },
  { id: 'w2b-333-decide-own', label: 'The asker never decides their own request (held, says why)', model: depthCase('owner', HELD_D(), {}, { dialog: { kind: 'decide', decision: 'APPROVED', words: '' } }, { compliance: held(REQUEST(), { withdraw: true }) }, DECIDER) },
  { id: 'w2b-333-override-approved', label: 'A second person said yes: it may be sent without the document (Send)', model: depthCase('buyer', HELD_D(), {}, {}, { compliance: part({ ...complianceOf(HELD_D(), 'met', REQUEST({ state: 'APPROVED', decidedBy: { id: uid('3333', 4), name: 'Paolo Demo' }, decidedAt: at(29, 10, 0) })), overridden: true }) }) },
  { id: 'w2b-333-override-rejected', label: 'A second person said no: still held, their words', model: depthCase('buyer', HELD_D(), {}, {}, { compliance: held(REQUEST({ state: 'REJECTED', decidedBy: { id: uid('3333', 4), name: 'Paolo Demo' }, decidedAt: at(29, 10, 0), words: 'Aspettiamo il rapporto: non ci sono garanzie sul lotto (demo).' })) }) },
  { id: 'w2b-333-schedule-draft', label: 'Delivery schedule (draft): the leather in two deliveries, the other lines one each; the calendar with the supplier’s closures', model: depthCase('buyer', DRAFT_D(), { tab: 'schedule' }) },
  { id: 'w2b-333-schedule-dialog', label: 'Split into deliveries: rows of quantity, day and note; the sum against the line (held until it is the line)', model: depthCase('buyer', DRAFT_D(), { tab: 'schedule' }, { dialog: { kind: 'schedule', lineId: leatherDepth().id, rows: [{ quantity: '220', needDate: '2026-11-20', note: '' }, { quantity: '180', needDate: '2026-11-27', note: 'Seconda tintura (demo)' }] } }) },
  { id: 'w2b-333-schedule-split', label: 'Split into deliveries: a line of one delivery starts as two, a week apart', model: depthCase('buyer', DRAFT_D(), { tab: 'schedule' }, { dialog: { kind: 'schedule', lineId: liningLine().id, rows: scheduleDraftOf(depthOf(DRAFT_D()).lines.find((line) => line.seq === 30)!) } }) },
  { id: 'w2b-333-schedule-refused', label: 'Split into deliveries refused by the API (a day past): said inside the dialog', model: depthCase('buyer', DRAFT_D(), { tab: 'schedule' }, { dialog: { kind: 'schedule', lineId: leatherDepth().id, rows: scheduleDraftOf(leatherDepth()) }, problem: { key: `${DEPTH}:schedule.refused.day` } }) },
  { id: 'w2b-333-schedule-clear', label: 'Back to one delivery', model: depthCase('buyer', DRAFT_D(), { tab: 'schedule' }, { dialog: { kind: 'clearSchedule', lineId: leatherDepth().id } }) },
  { id: 'w2b-333-schedule-sent', label: 'Delivery schedule (confirmed): delivery 2 confirmed 7 days later than needed; the day moved, who and why', model: depthCase('buyer', SENT_D(), { tab: 'schedule' }) },
  { id: 'w2b-333-date-first', label: 'Record the supplier’s day (its first): no reason asked; the day asked stays', model: depthCase('buyer', depthOrder(order('SENT')), { tab: 'schedule' }, { depth: part(depthOf(depthOrder(order('SENT')), 'split')), dialog: { kind: 'supplierDate', draft: { lineId: leatherDepth().id, deliveryId: uid('5804', 2), mode: 'FIRST', from: '2026-11-27', date: '2026-12-02', source: 'SUPPLIER', reason: '', contact: 'Marta Demo' } } }) },
  { id: 'w2b-333-date-move', label: 'The supplier moves the day: who said it, why (required)', model: depthCase('buyer', SENT_D(), { tab: 'schedule' }, { dialog: { kind: 'supplierDate', draft: { lineId: leatherDepth().id, deliveryId: uid('5804', 2), mode: 'MOVED', from: '2026-12-04', date: '2026-12-09', source: 'BUYER', reason: '', contact: '' } } }) },
  { id: 'w2b-333-schedule-one', label: 'Delivery schedule: one delivery per line (nothing split yet)', model: depthCase('buyer', DRAFT_D(), { tab: 'schedule' }, { depth: part(depthOf(DRAFT_D(), 'one')) }) },
  { id: 'w2b-333-schedule-no-closures', label: 'Delivery schedule for a planner: no parties.view, so no closures (said); read only, no price', model: depthCase('planner', SENT_D(), { tab: 'schedule' }) },
  { id: 'w2b-333-schedule-loading', label: 'Delivery schedule: loading', model: depthCase('buyer', DRAFT_D(), { tab: 'schedule' }, { depth: PART_LOADING, closures: PART_LOADING }) },
  { id: 'w2b-333-schedule-error', label: 'Delivery schedule: couldn’t load (Try again; never drawn as empty)', model: depthCase('buyer', DRAFT_D(), { tab: 'schedule' }, { depth: { value: null, problem: 'problem.offline' } }) },
  { id: 'w2b-333-kind-rolls', label: 'Rolls, certificate and variant…: a lining by rolls (3 × 50 m × 150 cm), a variant', model: depthCase('buyer', DRAFT_D(), {}, { dialog: { kind: 'lineKind', draft: kindDraftOf(lining()) } }) },
  { id: 'w2b-333-kind-protector', label: 'Rolls, certificate and variant…: a protector’s certificate (EN 1621) from the register, its size variant', model: depthCase('buyer', DRAFT_D(), {}, { dialog: { kind: 'lineKind', draft: kindDraftOf(protector()) } }) },
  { id: 'w2b-333-kind-warnings', label: 'Lines: the rolls no longer make the quantity; the certificate no longer holds', model: depthCase('buyer', DRAFT_D(), {}, { kinds: part(kindsOf(DRAFT_D(), { rolls: { count: 2, lengthM: '50.00', widthCm: '140.00', makes: '100.0000', matches: false }, certificate: { id: uid('5807', 2), number: 'CERT-DEMO-0002', standard: 'EN 1621-1:2012', status: 'SUSPENDED', validFrom: '2025-02-01', validTo: '2027-01-31', state: 'NOT_VALID', endsBeforeNeed: false } })) }) },
  { id: 'w2b-333-currency', label: 'Totals in USD: the rate at order (1 EUR = 1,085 USD) and the net in EUR, frozen with the send', model: depthCase('buyer', USD_D(), {}, { depth: part(depthOf(USD_D(), 'one', { rateAtOrder: '1.08500000', companyNetAmount: 219_816 })) }) },
  { id: 'w2b-333-currency-no-rate', label: 'Totals in USD without a rate yet: the send asks for it (Set the rate)', model: depthCase('buyer', { ...USD_D(), send: { ready: false, checks: [{ code: 'NO_RATE_AT_ORDER', severity: 'BLOCKS', path: 'rateAtOrder' }] } }, {}, { depth: part(depthOf(USD_D(), 'one')) }) },
  { id: 'w2b-333-rate', label: 'Set the rate at order: 1 EUR = how many USD (the accountant confirms the euro value)', model: depthCase('buyer', USD_D(), {}, { depth: part(depthOf(USD_D(), 'one')), dialog: { kind: 'rate', rate: '1.085' } }) },
  { id: 'w2b-333-receipts', label: 'Receipts › received against the order: over the tolerance, short, nothing yet', model: depthCase('buyer', PARTLY_D(), { tab: 'receipts' }, { depth: part(depthOf(PARTLY_D(), 'later')) }) },
  { id: 'w2b-333-chase', label: 'Chase Conceria Demo: the lines late or unconfirmed, ticked; the mail in Italian (preview)', model: depthCase('buyer', SENT_D(), {}, { chase: chaseModel(SENT_D()) }) },
  { id: 'w2b-333-chase-loading', label: 'Chase: reading what is late', model: depthCase('buyer', SENT_D(), {}, { chase: chaseModel(SENT_D(), { preview: { status: 'loading' } }) }) },
  { id: 'w2b-333-chase-nothing', label: 'Chase: nothing late or waiting (Send chase held)', model: depthCase('buyer', SENT_D(), {}, { chase: chaseModel(SENT_D(), { preview: { status: 'ready', value: chaseOf(SENT_D(), { lines: [], allowed: false }) } }) }) },
  { id: 'w2b-333-chase-no-contact', label: 'Chase held: no contact with an e-mail receives orders', model: depthCase('buyer', SENT_D(), {}, { chase: chaseModel(SENT_D(), { preview: { status: 'ready', value: chaseOf(SENT_D(), { recipient: null, allowed: false }) } }) }) },
  { id: 'w2b-333-chase-done', label: 'Chase sent: to whom and when (FAKE mail locally)', model: depthCase('buyer', SENT_D(), {}, { chase: chaseModel(SENT_D(), { done: { to: 'ordini@conceria-demo.example.com', at: at(29, 11, 40) } }) }) },
  { id: 'w2b-333-chase-failed', label: 'Chase: couldn’t read what to chase (Try again)', model: depthCase('buyer', SENT_D(), {}, { chase: chaseModel(SENT_D(), { preview: { status: 'error', problem: 'problem.offline' } }) }) },
  { id: 'w2b-333-chase-no-right', label: 'Chase held for a planner (no purchasing.send)', model: depthCase('planner', SENT_D(), {}, { chase: chaseModel(SENT_D()) }) },
  { id: 'w2b-333-duplicate', label: 'Duplicate: every line not cancelled, one need date or each its own, what is and is not copied', model: depthCase('buyer', SENT_D(), {}, { dialog: { kind: 'duplicate', draft: { lineIds: SENT_D().lines.map((line) => line.id), needDate: '' } } }) },
  { id: 'w2b-333-reorder', label: 'Reorder 1 line (picked on Lines), need date 4 Dec', model: depthCase('buyer', SENT_D(), {}, { dialog: { kind: 'duplicate', draft: { lineIds: [liningLine().id], needDate: '2026-12-04' } } }) },
  { id: 'w2b-333-reorder-selection', label: 'Lines selected: Reorder N lines', model: depthCase('buyer', SENT_D(), { selected: [liningLine().id, protectorLine().id] }) },
  { id: 'w2b-333-send-documents', label: 'Send: the check list says the documents are valid; a rule will ask Finance for a yes first', model: { ...depthCase('buyer', DRAFT_D(), { dialog: { kind: 'send' } }, { approval: part(approvalOf(DRAFT_D(), 'NONE', { wouldAsk: { rule: { id: uid('7301', 1), name: 'Ordini oltre 1.000 € (demo)' }, approver: { kind: 'ROLE', id: uid('3434', 2), name: 'Finance' }, namesYou: false } })) }), send: { check: ready(SEND_DOCS(false)) } } },
  { id: 'w2b-333-send-held-documents', label: 'Send held: a document is missing (the W2b gate), its Fix link to Lines', model: { ...depthCase('buyer', HELD_D(), { dialog: { kind: 'send' } }, {}, { compliance: held() }), send: { check: ready(SEND_DOCS(true)) } } },
  { id: 'w2b-333-approval-waiting', label: 'Waiting for a yes from Finance: nothing sent, everything held; Open in Approvals, Take the request back', model: depthCase('buyer', depthOrder(order('PENDING_APPROVAL')), {}, {}, { approval: part(approvalOf(depthOrder(order('PENDING_APPROVAL')), 'WAITING')) }) },
  { id: 'w2b-333-approval-withdraw', label: 'Take the request for a yes back: the order is a draft again', model: depthCase('buyer', depthOrder(order('PENDING_APPROVAL')), {}, { dialog: { kind: 'withdrawApproval', note: '' } }, { approval: part(approvalOf(depthOrder(order('PENDING_APPROVAL')), 'WAITING')) }) },
  { id: 'w2b-333-approval-rejected', label: 'Finance said no: a draft again, why and their words', model: depthCase('buyer', DRAFT_D(), {}, {}, { approval: part(approvalOf(DRAFT_D(), 'REJECTED')) }) },
  { id: 'w2b-333-approval-sent', label: 'Sent with its yes', model: depthCase('buyer', SENT_D(), {}, {}, { approval: part(approvalOf(SENT_D(), 'SENT_WITH_YES')) }) },
  { id: 'w2b-333-warehouse', label: 'Warehouse: no money (no totals, no prices), For orders and the held mark read only, nothing written', model: depthCase('warehouse', PARTLY_D(), {}, { depth: part(depthOf(PARTLY_D(), 'later')) }) },
  { id: 'w2b-333-read-only', label: 'Read-only: the schedule and kinds shown, every verb absent or held', model: depthCase('readOnly', SENT_D(), { tab: 'schedule' }) },
  { id: 'w2b-333-parts-failed', label: 'The depth reads failed: For orders “could not be read”, the documents check said so, totals in the order’s currency', model: depthCase('buyer', DRAFT_D(), {}, {}, { depth: { value: null, problem: 'problem.offline' }, kinds: { value: null, problem: 'problem.offline' }, compliance: { value: null, problem: 'problem.offline' }, demand: { value: null, problem: 'problem.offline' }, approval: { value: null, problem: 'problem.offline' } }) },
  { id: 'w2b-333-offline-chase', label: 'Offline: Chase held “Offline”', model: depthCase('buyer', SENT_D(), { live: 'offline' }, { chase: chaseModel(SENT_D()) }) },
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
    ...DEPTH_CASES,
    // B-W2b-347: a PO of type Sample (opened from Purchasing › Sourcing & claims › RFQs & sourcing, SCR-222).
    {
      id: 'w2b-347-sample-order',
      label: 'A sample order: the Sample order tag, the style and sample round it buys for, not counted in production spend',
      model: recordCase('buyer', 'DRAFT', {}, order('DRAFT', { sample: { style: { id: '0190f0e2-9203-7000-8000-000000000001', code: 'GIA-DEMO-01', name: 'Giacca Demo Touring' }, round: { id: '0190f0e2-9204-7000-8000-000000000001', number: 'SR-2026-0007', kind: 'PROTO', roundNo: 1, stage: 'REQUESTED' } } })),
    },
  ],
})

