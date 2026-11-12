import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { createTranslator, CATALOGUE } from '../../../../lib/i18n/messages'
import type { Locale } from '../../../../lib/i18n/locales'
import { at, PREFIX, shellOf, words as returnsWords } from '../design-data'
import type { Repair } from './api'
import { repairBandOf } from './band'
import { answerHeldKey, NS, photosHeldKey } from './model'
import { RepairCase, type RepairCaseBuilder } from './RepairCase'
import type { RepairDialog, RepairRecordViewModel } from './RepairRecordView'

/**
 * SCR-358 — a customer's repair in the portal (B-W2b-342; SAL-384, SAL-385, SAL-387; RR1:02; design portal.customer.returns
 * rec "Return" › Request / Status for a repair, repair.estimate "Parts and labour, approved by the customer before work
 * starts"), MADE-UP data only: a repair at each stage (waiting for the garment with where to send it, received, an estimate
 * to answer, accepted, declined, in repair, repaired, sent back, cancelled), an alteration, the Request with the damage
 * photos, Accept (asked, refused) and Decline (with its words, empty), Add photos and a photo full size; a colleague who
 * sees no prices, one who may only read, a past estimate, an office preview, no connection, loading, a failed read, a
 * repair that is not theirs and a person without the page.
 */

const id = (n: number) => `0190f0e2-1970-7000-8000-${String(n).padStart(12, '0')}`
const words = (locale: Locale) => createTranslator(locale, CATALOGUE[locale][NS] ?? {})

type Stage = 'AWAITING_GOODS' | 'RECEIVED' | 'ESTIMATED' | 'APPROVED' | 'IN_REPAIR' | 'REPAIRED' | 'SHIPPED' | 'CANCELLED'
const ORDER = ['RECEIVED', 'ESTIMATED', 'APPROVED', 'IN_REPAIR', 'REPAIRED', 'SHIPPED'] as const

function stepsAt(stage: Stage): Repair['steps'] {
  const current = (ORDER as readonly string[]).indexOf(stage)
  return ORDER.map((step, index) => {
    if (stage === 'AWAITING_GOODS') return { stage: step, state: 'WAITING' as const, at: null }
    if (stage === 'CANCELLED') return { stage: step, state: index === 0 ? ('DONE' as const) : ('SKIPPED' as const), at: index === 0 ? at(-48) : null }
    if (index < current) return { stage: step, state: 'DONE' as const, at: at(-48 + index * 6) }
    if (index === current) return { stage: step, state: 'CURRENT' as const, at: at(-2) }
    return { stage: step, state: 'WAITING' as const, at: null }
  })
}

const NEXT: Record<Stage, Repair['next']> = {
  AWAITING_GOODS: { code: 'SEND_GARMENT', forYou: true },
  RECEIVED: { code: 'WE_ESTIMATE', forYou: false },
  ESTIMATED: { code: 'ANSWER_ESTIMATE', forYou: true },
  APPROVED: { code: 'WE_REPAIR', forYou: false },
  IN_REPAIR: { code: 'WE_REPAIR', forYou: false },
  REPAIRED: { code: 'WE_CHECK', forYou: false },
  SHIPPED: { code: 'DONE', forYou: false },
  CANCELLED: { code: 'CANCELLED', forYou: false },
}

function estimate(status: 'SENT' | 'ACCEPTED' | 'DECLINED', prices = true, over: Partial<NonNullable<Repair['estimate']>> = {}): NonNullable<Repair['estimate']> {
  const price = <T>(value: T): T | undefined => (prices ? value : undefined)
  return {
    id: id(3601),
    revision: 1,
    status,
    currency: 'EUR',
    validUntil: '2026-11-30',
    customerNote: 'Il prezzo comprende la spedizione di ritorno con corriere.',
    sentAt: at(-6),
    answeredAt: status === 'SENT' ? null : at(-1),
    answeredVia: status === 'SENT' ? null : 'PORTAL',
    declineReason: status === 'DECLINED' ? 'Troppo caro per una giacca di quattro anni.' : null,
    version: 2,
    lines: [
      { seq: 10, kind: 'PART', description: 'Protezione spalla, livello 2', quantity: '1', minutes: null, unitPrice: price('18.500000'), amount: price(1850) },
      { seq: 20, kind: 'LABOUR', description: 'Ricucire la cucitura della spalla sinistra', quantity: '1', minutes: 40, unitPrice: price('35.000000'), amount: price(3500) },
    ],
    amount: price(5350),
    partsAmount: price(1850),
    labourAmount: price(3500),
    labourMinutes: 40,
    ...over,
  }
}

function repair(stage: Stage, over: Partial<Repair> = {}): Repair {
  const estimating = stage === 'ESTIMATED'
  const answered = ['APPROVED', 'IN_REPAIR', 'REPAIRED', 'SHIPPED'].includes(stage)
  return {
    id: id(3501),
    number: 'REP-2026-0042',
    kind: 'REPAIR',
    stage,
    channel: 'PORTAL',
    opened: at(-72),
    version: 3,
    open: stage !== 'SHIPPED' && stage !== 'CANCELLED',
    problem: 'Dopo una scivolata la cucitura della spalla sinistra si è aperta e la protezione si sposta.',
    workWanted: 'Ricucire la spalla e controllare la protezione.',
    garment: { style: { code: 'JKT-DEMO-01', name: 'Giacca Demo Touring' }, colourway: { code: 'NER', name: 'Nero' }, size: '52', serial: 'SN-DEMO-000123' },
    steps: stepsAt(stage),
    next: NEXT[stage],
    receivedAt: stage === 'AWAITING_GOODS' ? null : at(-48),
    repairedAt: ['REPAIRED', 'SHIPPED'].includes(stage) ? at(-12) : null,
    shippedAt: stage === 'SHIPPED' ? at(-2) : null,
    cancelledAt: stage === 'CANCELLED' ? at(-2) : null,
    sendTo: stage === 'AWAITING_GOODS' ? { name: 'Laboratorio Demo', address: 'Via dei Conciatori Finti 1, 50100 Firenze (FI), IT' } : null,
    photos: [
      { id: id(3701), name: 'spalla-1.jpg', contentType: 'image/jpeg', sizeBytes: 812_000, status: 'AVAILABLE', at: at(-70) },
      { id: id(3702), name: 'spalla-2.jpg', contentType: 'image/jpeg', sizeBytes: 744_000, status: 'AVAILABLE', at: at(-70) },
    ],
    estimate: estimating ? estimate('SENT') : answered ? estimate('ACCEPTED') : null,
    actions: { addPhotos: ['AWAITING_GOODS', 'RECEIVED', 'ESTIMATED'].includes(stage) ? null : 'STAGE', answer: estimating ? null : 'NOT_ASKED' },
    ...over,
  }
}

interface Build {
  repair: Repair
  tab?: 'status' | 'request'
  seesPrices?: boolean
  offline?: boolean
  preview?: boolean
  dialog?: RepairDialog | null
  notice?: RepairRecordViewModel['notice']
  state?: RepairRecordViewModel['state']
}

function repairCase(build: (locale: Locale) => Build): RepairCaseBuilder {
  return (locale) => {
    const input = build(locale)
    const t = words(locale)
    const offline = input.offline ?? false
    const photosHeld = photosHeldKey(input.repair.actions.addPhotos, offline)
    const model: RepairRecordViewModel = {
      state: input.state ?? 'ready',
      repair: input.repair,
      tab: input.tab ?? 'status',
      prefix: PREFIX,
      offlineSince: offline ? at(-1) : null,
      seesPrices: input.seesPrices ?? true,
      notice: input.notice ?? null,
      photosHeld,
      answerHeld: answerHeldKey(input.repair.actions.answer, offline, false),
      fileHeld: input.preview ? t('portal.held.photos.PREVIEW') : offline ? t('portal.held.offline') : null,
      dialog: input.dialog ?? null,
    }
    const band =
      model.state === 'ready'
        ? repairBandOf({ t, listTitle: returnsWords(locale)('list.title'), repair: input.repair, tab: model.tab, prefix: PREFIX, photosHeld })
        : { title: model.state === 'missing' ? t('portal.record.missing') : returnsWords(locale)('list.title'), back: { href: `${PREFIX}/returns`, label: returnsWords(locale)('list.title') } }
    return { shell: shellOf(locale, band, { path: '/returns', preview: input.preview ?? false }), body: { kind: 'record', model } }
  }
}

const sent = () => repair('ESTIMATED')
const decline = (reason: string, tried = false): RepairDialog => ({ kind: 'decline', busy: false, problem: null, reason, tried })

export const designScreen = defineDesignScreen<RepairCaseBuilder>({
  screen: 'SCR-358',
  title: 'Customer repair or alteration (portal.customer.returns, a repair’s record)',
  view: RepairCase,
  cases: [
    { id: 'waiting', label: 'Status › waiting for the garment: where to send it', model: repairCase(() => ({ repair: repair('AWAITING_GOODS', { estimate: null }) })), note: 'The steps (none reached yet), “Next step for you: send us the garment with a DDT”, the repairing site’s address and the number to put on the DDT; no estimate yet. Add photos is the band’s primary.' },
    { id: 'received', label: 'Status › received: we estimate', model: repairCase(() => ({ repair: repair('RECEIVED') })) },
    { id: 'estimate', label: 'Status › an estimate to answer', model: repairCase(() => ({ repair: sent() })), note: 'Parts and work (quantity, work time, price, total) with the total, the last day, our note; Accept the estimate / Decline. Prices are the price grain.' },
    { id: 'estimate-no-prices', label: 'Status › an estimate, for a colleague who sees no prices', model: repairCase(() => ({ repair: repair('ESTIMATED', { estimate: estimate('SENT', false), actions: { addPhotos: null, answer: 'NO_PRICES' } }), seesPrices: false })), note: 'The lines without a price; Accept and Decline held: “someone who sees them answers the estimate”.' },
    { id: 'estimate-viewer', label: 'Status › an estimate, for a colleague who may only read', model: repairCase(() => ({ repair: repair('ESTIMATED', { actions: { addPhotos: 'NO_REQUEST', answer: 'NO_REQUEST' } }) })) },
    { id: 'estimate-expired', label: 'Status › an estimate past its last day', model: repairCase(() => ({ repair: repair('ESTIMATED', { estimate: estimate('SENT', true, { validUntil: '2026-11-01' }), actions: { addPhotos: null, answer: 'EXPIRED' } }) })) },
    { id: 'accept', label: 'Accept the estimate?', model: repairCase(() => ({ repair: sent(), dialog: { kind: 'accept', busy: false, problem: null } })), note: 'DS ActionConfirm: the amount, and that the work starts.' },
    { id: 'accept-refused', label: 'Accept refused (the estimate changed meanwhile)', model: repairCase(() => ({ repair: sent(), dialog: { kind: 'accept', busy: false, problem: 'portal.problem.changed' } })) },
    { id: 'decline', label: 'Decline the estimate (with your words)', model: repairCase(() => ({ repair: sent(), dialog: decline('Troppo caro per una giacca di quattro anni.') })), note: 'DS Modal: why (needed); Keep it / Decline the estimate.' },
    { id: 'decline-empty', label: 'Decline without words', model: repairCase(() => ({ repair: sent(), dialog: decline('', true) })), note: 'The button held with why; the field says it after a try.' },
    { id: 'accepted', label: 'Accepted: the notice', model: repairCase(() => ({ repair: repair('APPROVED'), notice: { tone: 'success', key: 'portal.notice.accepted', params: { number: 'REP-2026-0042' } } })), note: 'The estimate says when and how it was accepted.' },
    { id: 'declined', label: 'Declined: we decide', model: repairCase(() => ({ repair: repair('ESTIMATED', { estimate: estimate('DECLINED'), next: { code: 'WE_DECIDE', forYou: false }, actions: { addPhotos: null, answer: 'NOT_ASKED' } }) })) },
    { id: 'in-repair', label: 'Status › in repair', model: repairCase(() => ({ repair: repair('IN_REPAIR') })), note: 'Add photos is gone from the band once the work started.' },
    { id: 'repaired', label: 'Status › repaired: we check it', model: repairCase(() => ({ repair: repair('REPAIRED') })) },
    { id: 'shipped', label: 'Status › sent back', model: repairCase(() => ({ repair: repair('SHIPPED') })) },
    { id: 'cancelled', label: 'Status › cancelled', model: repairCase(() => ({ repair: repair('CANCELLED', { estimate: null }) })) },
    { id: 'request', label: 'Request › what you asked, the damage photos', model: repairCase(() => ({ repair: repair('AWAITING_GOODS', { estimate: null }), tab: 'request' })), note: 'The kind, when and how it was asked, the garment, what is wrong, the work wanted; the photos with View and Add photos.' },
    { id: 'request-alteration', label: 'Request › an alteration (no photos needed)', model: repairCase(() => ({ repair: repair('RECEIVED', { kind: 'ALTERATION', problem: 'Allungare le maniche di 2 cm.', workWanted: 'Allungare le maniche di 2 cm.', photos: [], channel: 'LINK' }), tab: 'request' })) },
    { id: 'request-closed', label: 'Request › the work started: photos held', model: repairCase(() => ({ repair: repair('IN_REPAIR'), tab: 'request' })) },
    {
      id: 'photos',
      label: 'Add photos — picked',
      model: repairCase(() => ({
        repair: repair('AWAITING_GOODS', { estimate: null }),
        tab: 'request',
        dialog: { kind: 'photos', model: { number: 'REP-2026-0042', targets: [{ id: null, label: 'Foto del danno', count: 2 }], target: null, picked: [{ id: 'p1', name: 'manica.jpg', type: 'image/jpeg', size: 912_000, state: 'waiting', problem: null }, { id: 'p2', name: 'video.mov', type: 'video/quicktime', size: 20_000_000, state: 'waiting', problem: 'photos.problem.type' }], left: 7, held: null, busy: false, done: null } },
      })),
    },
    { id: 'photo', label: 'A photo full size', model: repairCase(() => ({ repair: repair('AWAITING_GOODS'), tab: 'request', dialog: { kind: 'photo', model: { photos: [{ id: id(3701), name: 'spalla-1.jpg' }, { id: id(3702), name: 'spalla-2.jpg' }], index: 0, state: 'loading', src: null } } })) },
    { id: 'preview', label: 'An office preview', model: repairCase(() => ({ repair: repair('ESTIMATED', { actions: { addPhotos: 'PREVIEW', answer: 'PREVIEW' } }), preview: true })), note: 'Every act held with the reason.' },
    { id: 'offline', label: 'No connection', model: repairCase(() => ({ repair: sent(), offline: true })) },
    { id: 'loading', label: 'Loading', model: repairCase(() => ({ repair: sent(), state: 'loading' })) },
    { id: 'error', label: 'The repair could not be read', model: repairCase(() => ({ repair: sent(), state: 'error' })) },
    { id: 'missing', label: 'Not one of theirs', model: repairCase(() => ({ repair: sent(), state: 'missing' })) },
    { id: 'no-access', label: 'Not part of the person’s access', model: (locale) => ({ shell: shellOf(locale, { title: returnsWords(locale)('list.title') }), body: { kind: 'noAccess', admins: ['Anna Esempio'] } }), note: 'A typed or old address (a designer, a supplier): who to ask, and Home.' },
  ],
})
