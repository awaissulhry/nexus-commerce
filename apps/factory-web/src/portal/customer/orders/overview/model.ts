import { shares } from '@nexus/factory-domain/production-brand/levels'
import { holdView, mostSerious, type PiecesColourway } from '../../../../lib/production/model'
import { wordsFor } from '../../../../lib/production/words'
import type { OrderRecord } from '../api'
import { APPROVAL_STATE_TONE, GATE_STATE_TONE, gatesEmpty, holdsOf, piecesOf, productionOwnsProgress, stageNoteOf } from '../../production/model'
import type { ProductionOrder } from '../../production/api'
import { milestoneSteps, movesOf, openDeposits, orderRefOf, promiseMoves, promiseOf, requestTone, shipToLines, stateLineKey, type Tone } from '../model'
import type { OrderWords } from '../words'
import type { OrderRecordViewModel } from '../view/OrderRecordView'

/**
 * pp-w2 (w2.1; lane pp-, the customer's order page on shared parts, round 1; 10-design § 5) — the Overview's view models, pure (no
 * React, no call): the page's own reads in, the words of the page's language out, one model per card in the office's reading order —
 * Where your order is, Progress by line, Next dates, Requests & changes, What you pay, Order facts (Quality and photos keeps its
 * body: QualityCard). Each fact once (L6): the promise and its moves only in Where; the requested date only in Next dates; one Pay
 * door (the deposit strip). A card without its right or level is null (LEFT OUT, never "Not shown"). Designer and Finance read no
 * production (L7): no stage, strips, gates or Quality — "Progress by line" comes from their old progress read, the same grid.
 * Wall PW-O01: no model holds an office key (`forbiddenKeysIn`) — so a step's stage note is `stageNote`, a request's note `yourNote`
 * — and none holds a key of money without the price grain.
 */

/** What the Overview reads of the page: its record view model (OrderPage fills it; a design case too) and its words. */
export type OverviewInput = Pick<OrderRecordViewModel, 'progress' | 'revision' | 'reconfirmHeld' | 'requests' | 'withdrawHeld' | 'pay' | 'production' | 'problem' | 'waitingHref' | 'offlineSince'> & {
  readonly record: OrderRecord
  readonly words: OrderWords
}

type StripTone = 'warning' | 'danger' | 'info'

/** A strip's ONE door: Review and confirm, See what waits for you ›, Pay the deposit, Ask a question, Try again. */
export type StripDoor =
  | { readonly kind: 'reconfirm'; readonly held: string | null }
  | { readonly kind: 'waiting'; readonly href: string }
  | { readonly kind: 'pay'; readonly depositId: string; readonly held: string | null }
  | { readonly kind: 'ask' }
  | { readonly kind: 'retryRevision' }

/** One strip of "Where your order is": what stops the order or waits for the customer, most blocking first. */
export interface WhereStrip {
  readonly id: 'reconfirm' | 'waiting' | 'deposit' | 'hold' | 'problem'
  readonly tone: StripTone
  readonly title: string
  readonly lines: readonly string[]
  readonly door: StripDoor | null
  /** A revised version waits: how many changes "What changed" lists (its lines are drawn from the approval page itself). */
  readonly changes?: number
}

export interface WhereModel {
  readonly title: string
  /** The headline: the status in the customer's words, and the stage while in production (a reader who sees production). */
  readonly headline: string
  readonly quiet: string | null
  /** "Live · as of 10:44" (the production read, read again on a timer); null: none (no production read). */
  readonly fresh: { readonly asOf: string; readonly everySeconds: number | null; readonly offline: boolean } | null
  readonly strips: readonly WhereStrip[]
  readonly stripsLabel: string
  /** The production read is being read (a quiet row), or failed (its row, with Try again). */
  readonly reading: boolean
  readonly failed: string | null
  /** The six order steps (the DS MilestoneTracker); the stage words go on "In production" (`stageNote`, drawn by the view). */
  readonly steps: ReturnType<typeof milestoneSteps>
  readonly stageNote: string | null
  readonly trackerLabel: string
  /** The promise: its day and the first one when it moved; null: no promise yet (`noPromise` says so), or a cancelled order. */
  readonly promise: { readonly label: string; readonly date: string; readonly first: string | null } | null
  readonly noPromise: string | null
  /** "Date moved twice ▾" and its history (the band's item went: the popover holds it). */
  readonly moves: { readonly count: number; readonly words: string; readonly open: string; readonly title: string; readonly history: readonly { readonly words: string; readonly reason: string | null }[] } | null
}

const stripToneOf = (tone: Tone): StripTone => (tone === 'danger' ? 'danger' : tone === 'warning' ? 'warning' : 'info')

/** Card 1 — Where your order is (5.1): always drawn. */
export function whereOf(input: OverviewInput): WhereModel {
  const { record, words } = input
  const { t, locale, day } = words
  const pw = wordsFor(locale)
  const order = record.order
  const production = input.production ?? null
  const read = production?.state === 'ready' ? production.read : null
  const inProduction = read !== null && read.inProduction
  const stage = inProduction && read.stage ? read.stage.words[locale] : null
  const delivered = record.milestones.find((step) => step.key === 'DELIVERED' && step.state === 'DONE')?.date ?? null
  const headline =
    order.status === 'CANCELLED'
      ? order.cancelledOn
        ? t('tracker.cancelledOn', { date: day(order.cancelledOn) })
        : t('tracker.cancelled')
      : order.status === 'DELIVERED' && delivered
        ? `${order.words[locale]} · ${day(delivered)}`
        : stage
          ? `${order.words[locale]} · ${stage}`
          : order.words[locale]
  const strips: WhereStrip[] = []
  // 1 · a revised version waits for the customer's yes (its own states while the approval is read).
  if (order.reconfirmNeeded) {
    const revision = input.revision
    const page = revision.page
    if (revision.state === 'error') strips.push({ id: 'reconfirm', tone: 'danger', title: t('reconfirm.failed'), lines: [], door: { kind: 'retryRevision' } })
    else if (revision.state === 'noAccess') strips.push({ id: 'reconfirm', tone: 'warning', title: t('reconfirm.bannerNoAccess'), lines: [t('reconfirm.askColleague')], door: null })
    else if (revision.state === 'ready' && page?.content.revisedOrder) {
      const revised = page.content.revisedOrder
      strips.push({
        id: 'reconfirm',
        tone: 'warning',
        title: t('reconfirm.banner', { version: revised.revision, date: day(page.request.dueAt) }),
        lines: [],
        door: { kind: 'reconfirm', held: input.reconfirmHeld },
        changes: revised.lines.length + revised.header.length,
      })
    } else if (revision.state === 'ready') strips.push({ id: 'reconfirm', tone: 'info', title: t('reconfirm.bannerSoon'), lines: [], door: null })
  }
  // 2 · we wait for the customer (never twice: a revision to re-confirm says it already).
  if (read && inProduction && !order.reconfirmNeeded && read.waiting.code === 'YOU') {
    strips.push({
      id: 'waiting',
      tone: 'warning',
      title: t('production.waitingTitle'),
      lines: read.waiting.since ? [t('production.waitingSince', { date: day(read.waiting.since) })] : [],
      door: input.waitingHref ? { kind: 'waiting', href: input.waitingHref } : null,
    })
  }
  // 3 · a deposit to pay (price grain only; the ONE Pay door of the page beside the band's ⋯).
  if (record.seesPrices) {
    for (const deposit of openDeposits(record.deposits)) {
      const pay = input.pay[deposit.id]
      if (!pay) continue
      strips.push({ id: 'deposit', tone: 'warning', title: t('strip.deposit', { date: day(deposit.dueDate) }), lines: order.depositRequired ? [t('deposit.gate')] : [], door: { kind: 'pay', depositId: deposit.id, held: pay.held } })
      break
    }
  }
  // 4 · what holds its work, in our curated words (the most serious, the rest counted), with "Ask a question".
  if (read) {
    const { hold, more } = mostSerious(holdsOf(read.holds, locale))
    if (hold) {
      const view = holdView('customer', hold, pw.day(hold.since))
      strips.push({ id: 'hold', tone: stripToneOf(view.tone), title: pw.say(view.title), lines: [view.body ? pw.say(view.body) : null, more > 0 ? pw.t('parts.hold.more', { count: more }) : null].filter((line): line is string => !!line), door: { kind: 'ask' } })
    }
  }
  // 5 · a problem it reported (our answer comes in Messages; "Report a problem" is in the band's ⋯).
  const chip = input.problem?.chip ?? null
  if (chip) strips.push({ id: 'problem', tone: stripToneOf(chip.tone), title: chip.text, lines: [], door: null })
  const promise = promiseOf(order)
  const count = order.status === 'CANCELLED' ? 0 : movesOf(record.promiseHistory)
  const stateLine = stateLineKey(order.status)
  return {
    title: t('tracker.title'),
    headline,
    // L2-G06 (B-TH-006): "Your order is confirmed" only for a confirmed order; waiting for our yes, said so (stateLineKey).
    quiet: stateLine ? t(stateLine) : null,
    fresh: read && inProduction ? { asOf: read.progress?.asOf ?? read.asOf, everySeconds: read.progress?.refreshSeconds ?? null, offline: input.offlineSince !== null } : null,
    strips,
    stripsLabel: t('overview.strips'),
    reading: production?.state === 'loading',
    failed: production?.state === 'error' ? t('production.failed') : null,
    steps: milestoneSteps(record.milestones, locale, day),
    stageNote: read && inProduction ? stageNoteOf(read, locale) : null,
    trackerLabel: t('tracker.label', { number: orderRefOf(order, t) }),
    promise: order.status !== 'CANCELLED' && promise.date ? { label: t('tracker.promise'), date: day(promise.date), first: promise.first ? t('tracker.firstPromised', { date: day(promise.first) }) : null } : null,
    noPromise: order.status !== 'CANCELLED' && !promise.date ? t('tracker.noPromise') : null,
    moves:
      count > 0
        ? {
            count,
            words: t('tracker.moved', { count }),
            open: t('history.open', { count }),
            title: t('history.title'),
            history: promiseMoves(record.promiseHistory, locale, day)
              .reverse()
              .map((move) => ({ words: move.from ? t('history.move', { on: move.on, from: move.from, to: move.to }) : t('history.set', { on: move.on, to: move.to }), reason: move.reason ?? null })),
          }
        : null,
  }
}

/** Card 2 — Progress by line (5.2): the shared PiecesGrid; the production read's, else (Finance, Designer: L7) the old read's. */
export interface ProgressModel {
  readonly title: string
  readonly state: 'loading' | 'error' | 'ready'
  readonly colourways: readonly PiecesColourway[]
  /** "Pieces as of 10:44"; null while not read. */
  readonly asOf: string | null
  readonly from: 'production' | 'progress'
  readonly failed: string | null
}

/** Left out (null) where no read shares the pieces (below + Progress, not in production, a cancelled order). */
export function progressOf(input: OverviewInput): ProgressModel | null {
  const { record, words } = input
  const { t, time } = words
  if (record.order.status === 'CANCELLED') return null
  const production = input.production ?? null
  const title = t('overview.progress')
  if (productionOwnsProgress(production)) {
    if (production?.state === 'loading') return { title, state: 'loading', colourways: [], asOf: null, from: 'production', failed: null }
    const pieces = production?.read?.progress ?? null
    if (!pieces) return null
    return { title, state: 'ready', colourways: piecesOf(pieces, t), asOf: t('overview.piecesAsOf', { time: time(pieces.asOf) }), from: 'production', failed: null }
  }
  if (!shares(record.productionLevel, 'progress') || input.progress.state === 'hidden') return null
  const old = input.progress.read
  if (input.progress.state === 'loading') return { title, state: 'loading', colourways: [], asOf: null, from: 'progress', failed: null }
  if (input.progress.state === 'error' || !old) return { title, state: 'error', colourways: [], asOf: null, from: 'progress', failed: t('progress.failed') }
  // The old read has the production read's own lines (the same shape): the same grid draws them.
  const same = { asOf: old.asOf, refreshSeconds: old.refreshSeconds, lines: old.lines, whole: old.whole, percent: old.percent }
  return { title, state: 'ready', colourways: piecesOf(same, t), asOf: t('overview.piecesAsOf', { time: time(old.asOf) }), from: 'progress', failed: null }
}

/** One row of a kit list: its label, its value, the row's quiet line, a chip, its ONE door. */
export interface OverviewRow {
  readonly id: string
  readonly label: string
  readonly value: string
  readonly hint?: string | null
  readonly chip?: { readonly words: string; readonly tone: Tone } | null
  readonly door?: { readonly words: string; readonly href: string } | null
}

/** Card 3 — Next dates (5.3): requested, our published plan, gates and approvals (production shared at + Gates & dates). */
export interface DatesModel {
  readonly title: string
  readonly rows: readonly OverviewRow[]
  /** Nothing planned yet, in one line. */
  readonly none: string | null
}

/** Left out (null) on a cancelled order (no next date). The promise is NOT here (once, in Where: L6). */
export function datesOf(input: OverviewInput): DatesModel | null {
  const { record, words } = input
  const { t, locale, day } = words
  const order = record.order
  if (order.status === 'CANCELLED') return null
  const rows: OverviewRow[] = [{ id: 'requested', label: t('facts.requested'), value: order.requestedDate ? day(order.requestedDate) : '—' }]
  const production = input.production ?? null
  const gates = production?.state === 'ready' ? (production.read?.gates ?? null) : null
  let none: string | null = null
  if (gates) {
    const waitDoor = input.waitingHref ? { words: t('production.waitingLink'), href: input.waitingHref } : null
    const planned = gates.planned
    if (planned.cutStart || planned.sewStart || planned.finish) {
      const dayOr = (value: string | null) => (value ? day(value) : '—')
      rows.push({
        id: 'planned',
        label: t('production.planned.label'),
        value: [`${t('production.planned.cutStart')} ${dayOr(planned.cutStart)}`, `${t('production.planned.sewStart')} ${dayOr(planned.sewStart)}`, `${t('production.planned.finish')} ${dayOr(planned.finish)}`].join(' · '),
        hint: t('production.planned.hint'),
      })
    }
    gates.gates.forEach((gate, index) =>
      rows.push({
        id: `gate-${gate.kind}-${index}`,
        label: gate.words[locale],
        value: gate.doneOn ? `${t('production.gates.done')} ${day(gate.doneOn)}` : gate.targetDate ? `${t('production.gates.planned')} ${day(gate.targetDate)}` : '—',
        chip: { words: t(`production.gates.states.${gate.state}`), tone: GATE_STATE_TONE[gate.state] },
        door: gate.state === 'WAITING_YOU' ? waitDoor : null,
      }),
    )
    gates.approvals.forEach((answer, index) =>
      rows.push({
        id: `approval-${answer.kind}-${index}`,
        label: answer.words[locale],
        value: answer.answeredOn ? `${t('production.approvals.answered')} ${day(answer.answeredOn)}` : answer.sentOn ? `${t('production.approvals.sent')} ${day(answer.sentOn)}` : '—',
        chip: { words: t(`production.approvals.states.${answer.state}`), tone: APPROVAL_STATE_TONE[answer.state] },
        door: answer.state === 'WAITING_YOU' ? waitDoor : null,
      }),
    )
    if (gatesEmpty(gates)) none = t('production.gates.none')
    else if (!planned.cutStart && !planned.sewStart && !planned.finish) none = t('production.planned.none')
  }
  // pp-fx4 (walk W-12): a card with nothing to say is left out — no requested date, no plan, no gate, no approval and no line in words.
  if (rows.length === 1 && !order.requestedDate && none === null) return null
  return { title: t('overview.dates'), rows, none }
}

/** One request of Requests & changes: what it is, its state, its age, our answer, its ONE Withdraw. */
export interface RequestRowModel {
  readonly id: string
  readonly what: string
  readonly chip: { readonly words: string; readonly tone: Tone }
  readonly since: string
  readonly age: string
  readonly askedDay: string
  readonly yourNote: string | null
  readonly answer: string | null
  /** Withdraw — every kind while it waits on us (O1-B6), held with words; null: none (not open). */
  readonly withdraw: { readonly held: string | null } | null
  /** A counter-offer of ours waits on the customer: its answer is in Waiting for you. */
  readonly door: { readonly words: string; readonly href: string } | null
}

export interface RequestsModel {
  readonly title: string
  readonly state: 'loading' | 'error' | 'ready'
  readonly failed: string | null
  readonly groups: readonly { readonly id: 'you' | 'us' | 'answered'; readonly title: string; readonly rows: readonly RequestRowModel[] }[]
  readonly nothing: string
}

const DAY_MS = 86_400_000

/** Card 4 — Requests & changes (5.3): grouped by who waits; left out (null) for a reader who may not read them. */
export function requestsOf(input: OverviewInput, now: number = Date.now()): RequestsModel | null {
  const { words } = input
  const { t, locale, day, at } = words
  const pw = wordsFor(locale)
  const requests = input.requests
  if (requests.state === 'noAccess') return null
  const base = { title: t('overview.requests'), nothing: t('overview.nothing') }
  if (requests.state === 'loading') return { ...base, state: 'loading', failed: null, groups: [] }
  if (requests.state === 'error') return { ...base, state: 'error', failed: t('requests.failed'), groups: [] }
  const rowOf = (request: (typeof requests.items)[number]): RequestRowModel => ({
    id: request.id,
    what: [request.kindWords[locale], whatOf(request, words)].filter(Boolean).join(' · '),
    chip: request.status === 'ACCEPTED' && request.followUp ? { words: t(`requests.followUp.${request.followUp}`), tone: request.followUp === 'DONE' ? 'success' : 'info' } : { words: request.words[locale], tone: requestTone(request.status) },
    since: request.askedAt,
    // The shared parts' own age word ("3 d" · "3 g"), never a written English letter.
    age: pw.t('parts.age.days', { count: Math.max(0, Math.floor((now - Date.parse(request.askedAt)) / DAY_MS)) }),
    askedDay: t(request.mine ? 'requests.askedByYou' : 'requests.asked', { when: at(request.askedAt) }),
    yourNote: request.note ? t('requests.note', { note: request.note }) : null,
    answer: request.answer ? t('requests.ourAnswer', { answer: request.answer }) : request.status === 'ACCEPTED' && request.answeredAt ? t('requests.acceptedOn', { date: day(request.answeredAt.slice(0, 10)) }) : null,
    withdraw: request.status === 'OPEN' ? { held: input.withdrawHeld } : null,
    door: request.status === 'COUNTERED' && input.waitingHref ? { words: t('production.waitingLink'), href: input.waitingHref } : null,
  })
  const you = requests.items.filter((request) => request.status === 'COUNTERED').map(rowOf)
  const us = requests.items.filter((request) => request.status === 'OPEN').map(rowOf)
  const answered = requests.items.filter((request) => request.status !== 'OPEN' && request.status !== 'COUNTERED').map(rowOf)
  const groups = [
    ...(you.length ? [{ id: 'you' as const, title: t('overview.groupYou', { count: you.length }), rows: you }] : []),
    ...(us.length ? [{ id: 'us' as const, title: t('overview.groupUs', { count: us.length }), rows: us }] : []),
    ...(answered.length ? [{ id: 'answered' as const, title: t('overview.groupAnswered', { count: answered.length }), rows: answered }] : []),
  ]
  return { ...base, state: 'ready', failed: null, groups }
}

/** What a request asks, in the customer's words (the cells, the date, the address, the lines, the fee, the files). */
function whatOf(request: OverviewInput['requests']['items'][number], words: OrderWords): string {
  const { t, locale, day } = words
  const parts: string[] = []
  if (request.kind === 'CANCEL') {
    parts.push(request.wholeOrder ? t('requests.wholeOrder') : t('requests.lines', { lines: [...new Set(request.cells.map((cell) => cell.seq))].join(', ') }))
    if (request.reasonWords) parts.push(request.reasonWords[locale])
    if (request.cancelFee?.pct && request.cancelFee.totalFee != null) parts.push(t('requests.fee', { fee: words.money(request.cancelFee.totalFee, request.cancelFee.currency) }))
  } else if (request.kind === 'DESIGN') {
    parts.push(t('requests.lines', { lines: [...new Set(request.cells.map((cell) => cell.seq))].join(', ') }))
    const files = request.fileIds?.length ?? 0
    if (files > 0) parts.push(t('ask.design.review.files', { count: files }))
    if (request.impact?.appliesTo) parts.push(t(`ask.design.appliesTo.${request.impact.appliesTo}`))
  } else {
    for (const cell of request.cells) parts.push(t('requests.cell', { seq: cell.seq, size: cell.size ?? '—', old: cell.before, new: cell.asked }))
    if (request.requestedDate) parts.push(t('requests.date', { date: day(request.requestedDate) }))
    if (request.shipTo) parts.push(t('requests.shipTo', { address: request.shipTo.label }))
  }
  return parts.join(' · ')
}

/** Card 5 — What you pay (5.4): price holders only (the money grain); facts only, the ONE Pay door is the deposit strip. */
export interface PayModel {
  readonly title: string
  readonly rows: readonly OverviewRow[]
}

/** Left out (null) without the price grain (the server sends no amount then) or with nothing to say. */
export function payOf(input: OverviewInput): PayModel | null {
  const { record, words } = input
  const { t, day } = words
  if (!record.seesPrices) return null
  const order = record.order
  const currency = order.currency
  const money = (minor: number | null | undefined) => words.money(minor, currency)
  const cancelled = order.status === 'CANCELLED'
  const deposits = record.deposits.map((deposit): OverviewRow => {
    const part = deposit.status === 'OPEN' && typeof deposit.paidAmount === 'number' && deposit.paidAmount > 0 ? t('overview.partPaid', { paid: money(deposit.paidAmount), amount: money(deposit.amount) }) : null
    const state = deposit.paidAt ? t('deposit.paidOn', { date: day(deposit.paidAt.slice(0, 10)) }) : t(`deposit.state.${deposit.status}`)
    return {
      id: `deposit-${deposit.id}`,
      label: t(`deposit.kind.${deposit.kind}`),
      value: deposit.status === 'OPEN' ? [money(deposit.amount), `${t('deposit.due')} ${day(deposit.dueDate)}`].join(' · ') : [money(deposit.amount), state].join(' · '),
      hint: part,
      chip: deposit.status === 'OPEN' ? { words: state, tone: 'warning' } : null,
    }
  })
  const fromDeposits = record.deposits.length > 0 ? record.deposits.filter((deposit) => deposit.status !== 'CANCELLED').reduce((sum, deposit) => sum + (typeof deposit.paidAmount === 'number' ? deposit.paidAmount : deposit.status === 'PAID' ? (deposit.amount ?? 0) : 0), 0) : null
  const gross = typeof order.grossAmount === 'number' ? order.grossAmount : null
  const still = cancelled ? 0 : typeof order.stillToPay === 'number' ? order.stillToPay : null
  // pp-fx4 (walk W-10): Paid is what the read says was paid — the total less what is still to pay (deposits AND invoices paid: a
  // shipped order's €200 had no row); only the deposits' when the read has no still-to-pay figure. A figure the read lacks is said so.
  const paid = gross !== null && still !== null ? Math.max(0, gross - still) : fromDeposits
  const figure = (value: number | null): Pick<OverviewRow, 'value' | 'hint'> => (value === null ? { value: '—', hint: t('overview.notRead') } : { value: money(value) })
  // pp-fx4 (walk W-16): one fact, one word — the total and what is left to pay say what Lines › Totals says.
  const rows: OverviewRow[] = cancelled
    ? [...deposits, { id: 'still', label: t('totals.toPay'), value: money(0) }]
    : [
        { id: 'total', label: t('totals.gross'), ...figure(gross) },
        ...deposits,
        { id: 'paid', label: t('overview.paid'), ...figure(paid) },
        { id: 'still', label: t('totals.toPay'), ...figure(still) },
      ]
  return { title: t('overview.pay'), rows }
}

/** Card 6 — Order facts (5.5): PO, ordered on, delivery address (lines only), terms, currency, no right of withdrawal. */
export interface FactsModel {
  readonly title: string
  readonly facts: readonly { readonly id: string; readonly label: string; readonly value: string; readonly lines?: readonly string[] }[]
}

export function factsOf(input: OverviewInput): FactsModel {
  const { record, words } = input
  const { t, day } = words
  const order = record.order
  const shipTo = shipToLines(order.shipTo)
  return {
    title: t('facts.title'),
    facts: [
      { id: 'po', label: t('ref.yours'), value: order.customerRef ?? '—' },
      { id: 'ordered', label: t('facts.orderedOn'), value: day(order.orderDate) },
      { id: 'shipTo', label: t('facts.shipTo'), value: shipTo.length > 0 ? shipTo.join(', ') : '—', lines: shipTo },
      { id: 'terms', label: t('facts.paymentTerms'), value: order.paymentTerms ?? '—' },
      { id: 'currency', label: t('facts.currency'), value: order.currency },
      ...(order.noWithdrawal ? [{ id: 'withdrawal', label: t('facts.withdrawal'), value: t('facts.noWithdrawal') }] : []),
    ],
  }
}

/** Every Overview model of one page at once (the tab draws them; PW-O01 walks them). */
export interface OverviewModels {
  readonly where: WhereModel
  readonly progress: ProgressModel | null
  readonly dates: DatesModel | null
  readonly requests: RequestsModel | null
  readonly pay: PayModel | null
  readonly facts: FactsModel
  /** Quality and photos: drawn (its own body, QualityCard) only at the level that shares it and for a reader who sees production. */
  readonly quality: boolean
}

export function overviewOf(input: OverviewInput & { readonly quality?: OrderRecordViewModel['quality'] }, now?: number): OverviewModels {
  const production: ProductionOrder | null = input.production?.state === 'ready' ? input.production.read : null
  return {
    where: whereOf(input),
    progress: progressOf(input),
    dates: datesOf(input),
    requests: requestsOf(input, now),
    pay: payOf(input),
    facts: factsOf(input),
    quality: production !== null && input.record.order.status !== 'CANCELLED' && !!input.quality && input.quality.state !== 'hidden',
  }
}
