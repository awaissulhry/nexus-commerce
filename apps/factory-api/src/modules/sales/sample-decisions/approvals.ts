import type { Prisma } from '@nexus/factory-db'
import { SAMPLE_ROUND_RECORD, SAMPLE_SWATCH_RECORD, type ApprovalLocale } from '@nexus/factory-domain/approvals-out/kinds'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { SALES_SAMPLES_DECIDE } from '@nexus/factory-domain/sales/sample-decisions/permissions'
import { answerHeldWords, askRefusal, decisionOfAnswer, noCompanyRefusal, swatchAnswerHeldWords, swatchAskRefusal, SWATCH_WORDS, type SwatchKind } from '@nexus/factory-domain/sales/sample-decisions/rules'
import { SALES_SAMPLES_VIEW } from '@nexus/factory-domain/sales/samples/permissions'
import { cellsOf, isOpenStage, roundLabel, type SampleKind, type SampleStage } from '@nexus/factory-domain/sales/samples/rules'
import { ANSWER_NOT_ON_RECORD_WORDS } from '@nexus/factory-domain/production-brand/override'
import type { CutStart } from '@nexus/factory-domain/sales/change-requests/rules'
import { OPEN_ORDER_STATUSES, type GateKind } from '@nexus/factory-domain/planning/milestones/rules'
import { InvalidStateError } from '@nexus/factory-domain/core/errors'
import type { CommandTools } from '../../../core/command'
import { words, type ApprovalRecord, type RecordAdapter, type RecordReverseFacts, type RequestRef, type ReverseInput } from '../../../platform/approvals-out/adapter'
import { readCuts } from '../change-requests/store'
import { readRoundRow, type Reader } from '../samples/store'
import { readSwatchRow, swatchCompanyOf, swatchFacts, waitingRequest } from './store'

/**
 * The brand decides a sample round or a swatch through the approvals engine (B-W2b-184; B-W2b-252 SAL-312, SAL-314; design
 * products.samples › Approval "Ask the customer (Links › Approve)"; links.approve "Sample, colour, leather: photos and spec,
 * comments with photo markup"): the office asks with POST /approvals-out {kind SAMPLE, recordType SampleRound} or {kind
 * COLOUR | LEATHER | FABRIC | TRIM (the swatch's own), recordType SampleSwatch}, sales.samples.decide + partners.approvals.ask over the
 * round's company and brand; the brand answers by its link or in its portal, once.
 *
 *   read       the round (its company, its brand, "SR-2026-0003 · Fit · round 2"), held while it may not be asked (internal,
 *              only requested, decided, cancelled, asked already) — a swatch: once sent, not decided, its own kind
 *              (B-PR-29: COLOUR, LEATHER, FABRIC or TRIM; a size set or a top-of-production round is asked as a SAMPLE as
 *              every round is, and its brand's named approver answers it: platform/approvals-out/approver.ts)
 *   onAsked    in the office's ask command: the round or swatch names its request (approvalRequestId), sample_round.asked /
 *              sample_swatch.changed ASKED
 *   answerHeld the round or swatch was decided or cancelled meanwhile, or a newer request was sent: the brand's answer is not
 *              taken ("This sample is decided already.")
 *   settle     in the tenant's SYSTEM scope right after the partner's answer (the partner role writes neither table): the
 *              answer becomes the decision — APPROVED, APPROVED_WITH_CHANGES → APPROVED_WITH_COMMENTS, REFUSED → REJECTED;
 *              the comments are the brand's words; decidedAt = the answer's time; PORTAL (decidedById = the portal person) or
 *              LINK (nobody named); a round goes DECIDED — the database checks it is that request's answer. A round or
 *              swatch decided meanwhile in the office keeps its decision (the settle says so in its audit row).
 *              B-PR-30a: decided FOR the brand by the office (Decide for the customer: a reason it reads, step-up, a second
 *              person when its switch is on) → OFFICE, decidedById = the office person who decided (the request's
 *              decidedForPartyById), the comments our words — the same request, so the gate passes by its round's event.
 *   reverseFacts B-PR-30b: the live cut of the brand's open lines of the style (a cut of leather logged, a bundle made), the
 *              gate the round passed; `held` (HELD) only when the round or swatch no longer holds the answer being put back
 *              (decided another way, or cancelled).
 *   reverse    B-PR-40 (schema wave 5/5: the database lets it through once the request names its reversal, which
 *              platform/approvals-out writes first): ROUND_UNDER_REVIEW — the round back UNDER_REVIEW, its decision cleared
 *              (sample_round.changed MOVED); GATE_WAITING — each gate it passed waits again (order_gate.changed EDITED; the
 *              database refuses it once work started on the gate's order, as the verdict does); SWATCH_UNDECIDED — the swatch's
 *              decision cleared (sample_swatch.changed UPDATED). The round or swatch keeps naming the request: the office asks
 *              the brand again with a new one.
 * The answer itself lands on the round's thread (the brand's own signed message), the engine's settle.
 */

const sizesWords = (cells: unknown, colourways: ReadonlyMap<string, string>): string =>
  cellsOf(cells)
    .map((cell) => `${cell.colourwayId ? `${colourways.get(cell.colourwayId) ?? ''} ` : ''}${cell.size} ×${cell.quantity}`)
    .join(', ')

const roundWords = (round: { number: string; kind: string; roundNo: number }) => ({
  it: `${round.number} · ${roundLabel(round.kind as SampleKind, round.roundNo, 'it')}`,
  en: `${round.number} · ${roundLabel(round.kind as SampleKind, round.roundNo, 'en')}`,
})

/** The brand's answer as a decision's columns, from the request (its time, its person or link, its words). */
async function answerOf(tools: CommandTools, request: RequestRef) {
  const row = await tools.tx.approvalRequest.findUnique({ where: { id: request.id }, select: { status: true, answer: true, typedName: true, answeredAt: true, answeredByUserId: true, answeredViaLinkId: true, decidedForPartyById: true } })
  const decision = row ? decisionOfAnswer(row.status) : null
  if (!row || !decision || !row.answeredAt) return null
  // B-PR-30a: decided for the brand by an office person → OFFICE, by that person (the database's rule for an office decision).
  const via = row.decidedForPartyById ? ('OFFICE' as const) : row.answeredViaLinkId ? ('LINK' as const) : ('PORTAL' as const)
  // A refusal and an approval with changes always carry the brand's words (approvals-out answerProblems); a word for safety.
  const comments = row.answer?.trim() || (decision === 'APPROVED' ? null : 'No words given.')
  const decidedById = via === 'OFFICE' ? row.decidedForPartyById : via === 'PORTAL' ? row.answeredByUserId : null
  return { decision, via, comments, decidedAt: row.answeredAt, decidedById, typedName: row.typedName }
}

// ---- B-PR-30b: what putting the brand's answer back would do --------------------------------------------------------------

/** The first cut, read live, of the brand's open order lines of this style (null: nothing cut yet, or an internal record). */
async function cutOfStyle(client: Reader, styleId: string, partyId: string | null, orderIds: readonly string[] = []): Promise<CutStart | null> {
  if (partyId === null) return null
  const lines = await client.salesOrderLine.findMany({ where: { partyId, OR: [{ styleId, order: { status: { in: [...OPEN_ORDER_STATUSES] } } }, ...(orderIds.length ? [{ orderId: { in: [...orderIds] } }] : [])] }, select: { id: true } })
  const cuts = [...(await readCuts(client, lines.map((line) => line.id))).values()]
  return cuts.reduce<CutStart | null>((first, cut) => (first === null || cut.day < first.day || (cut.day === first.day && cut.leather && !first.leather) ? cut : first), null)
}

/**
 * B-PR-40: the record's decision is the answer being put back — decided by this request, at its answer's time (a portal, link or
 * decided-for answer; the database's own test, factory_sample_decision_reversed).
 */
const holdsAnswer = (row: { readonly decision: string | null; readonly decidedAt: Date | null; readonly approvalRequestId: string | null }, request: RequestRef): boolean =>
  row.decision !== null && row.approvalRequestId === request.id && row.decidedAt !== null && request.answeredAt !== null && row.decidedAt.getTime() === request.answeredAt.getTime()

async function roundReverseFacts(client: Reader, request: RequestRef): Promise<RecordReverseFacts> {
  const round = await readRoundRow(client, request.recordId)
  const gates = round ? await client.orderGate.findMany({ where: { sampleRoundId: round.id, passedAt: { not: null } }, select: { salesOrderId: true } }) : []
  return {
    sampleKind: round?.kind ?? null,
    cut: round ? await cutOfStyle(client, round.styleId, round.partyId, gates.map((gate) => gate.salesOrderId)) : null,
    passedGate: gates.length > 0,
    applied: false,
    // B-PR-40: put back only while the round still holds this answer (DECIDED by it); else nothing is marked put back.
    held: round && round.stage === 'DECIDED' && holdsAnswer(round, request) ? null : { code: 'HELD', words: ANSWER_NOT_ON_RECORD_WORDS.SampleRound },
  }
}

async function swatchReverseFacts(client: Reader, request: RequestRef): Promise<RecordReverseFacts> {
  const swatch = await readSwatchRow(client, request.recordId)
  return {
    sampleKind: null,
    cut: swatch ? await cutOfStyle(client, swatch.styleId, swatch.partyId) : null,
    passedGate: false,
    applied: false,
    // B-PR-40: put back only while the swatch still holds this answer (decided by it); else nothing is marked put back.
    held: swatch && holdsAnswer(swatch, request) ? null : { code: 'HELD', words: ANSWER_NOT_ON_RECORD_WORDS.SampleSwatch },
  }
}

/** A row the verdict let through changed meanwhile (the request's lock does not hold the record): the command stops. */
const MOVED_MEANWHILE = 'The sample changed meanwhile: read it again.'

/**
 * B-PR-40: the round back UNDER_REVIEW with its decision cleared, then (GATE_WAITING) each gate it passed waiting again, in the
 * office's reversal command after the request's reversal (the database checks both against it).
 */
async function roundReverse(tools: CommandTools, request: RequestRef, input: ReverseInput): Promise<Prisma.InputJsonObject | null> {
  if (!input.effects.includes('ROUND_UNDER_REVIEW')) return null
  const round = await readRoundRow(tools.tx, request.recordId)
  if (!round || round.stage !== 'DECIDED' || !holdsAnswer(round, request)) throw new InvalidStateError(MOVED_MEANWHILE)
  const { count } = await tools.tx.sampleRound.updateMany({
    where: { id: round.id, version: round.version, stage: 'DECIDED' },
    data: { stage: 'UNDER_REVIEW', decision: null, decisionComments: null, decidedAt: null, decidedVia: null, decidedById: null, version: { increment: 1 }, updatedAt: tools.now },
  })
  if (count !== 1) throw new InvalidStateError(MOVED_MEANWHILE)
  tools.audit({
    action: 'sales.samples.reverse',
    recordType: SAMPLE_ROUND_RECORD,
    recordId: round.id,
    companyId: round.companyId,
    before: { stage: 'DECIDED', decision: round.decision, decidedVia: round.decidedVia, decidedAt: round.decidedAt ? toUtcIso(round.decidedAt) : null, approvalRequestId: request.id },
    after: { stage: 'UNDER_REVIEW', decision: null, reversedBy: input.actorId },
  })
  tools.emit({ type: 'sample_round.changed', subject: round.id, companyId: round.companyId, payload: { sampleRoundId: round.id, number: round.number, styleId: round.styleId, stage: 'UNDER_REVIEW', previousStage: 'DECIDED', change: 'MOVED', workOrderId: null } })
  const gatesWaiting: string[] = []
  if (input.effects.includes('GATE_WAITING')) {
    const gates = await tools.tx.orderGate.findMany({
      where: { sampleRoundId: round.id, passedAt: { not: null } },
      select: { id: true, companyId: true, salesOrderId: true, partyId: true, kind: true, overriddenAt: true, version: true, salesOrder: { select: { number: true } } },
      orderBy: { id: 'asc' },
    })
    for (const gate of gates) {
      const moved = await tools.tx.orderGate.updateMany({ where: { id: gate.id, version: gate.version }, data: { passedAt: null, passedById: null, version: { increment: 1 }, updatedAt: tools.now } })
      if (moved.count !== 1) throw new InvalidStateError(MOVED_MEANWHILE)
      tools.audit({ action: 'planning.gates.reverse', recordType: 'OrderGate', recordId: gate.id, companyId: gate.companyId, before: { passed: true }, after: { passed: false, sampleRoundId: round.id, reversedBy: input.actorId } })
      tools.emit({
        type: 'order_gate.changed',
        subject: gate.id,
        companyId: gate.companyId,
        payload: { gateId: gate.id, salesOrderId: gate.salesOrderId, number: gate.salesOrder.number, partyId: gate.partyId, kind: gate.kind as GateKind, change: 'EDITED', via: null, passed: false, startedBefore: gate.overriddenAt !== null },
      })
      gatesWaiting.push(gate.id)
    }
  }
  return { sampleRoundId: round.id, stage: 'UNDER_REVIEW', gatesWaiting }
}

/** B-PR-40: the swatch's decision cleared, in the office's reversal command after the request's reversal. */
async function swatchReverse(tools: CommandTools, request: RequestRef, input: ReverseInput): Promise<Prisma.InputJsonObject | null> {
  if (!input.effects.includes('SWATCH_UNDECIDED')) return null
  const swatch = await readSwatchRow(tools.tx, request.recordId)
  if (!swatch || !holdsAnswer(swatch, request)) throw new InvalidStateError(MOVED_MEANWHILE)
  const companyId = await swatchCompanyOf(tools.tx, swatch)
  const { count } = await tools.tx.sampleSwatch.updateMany({
    where: { id: swatch.id, version: swatch.version },
    data: { decision: null, decisionComments: null, decidedAt: null, decidedVia: null, decidedById: null, version: { increment: 1 }, updatedAt: tools.now },
  })
  if (count !== 1) throw new InvalidStateError(MOVED_MEANWHILE)
  tools.audit({
    action: 'sales.samples.swatchReverse',
    recordType: SAMPLE_SWATCH_RECORD,
    recordId: swatch.id,
    companyId,
    before: { decision: swatch.decision, decidedVia: swatch.decidedVia, decidedAt: swatch.decidedAt ? toUtcIso(swatch.decidedAt) : null, approvalRequestId: request.id },
    after: { decision: null, reversedBy: input.actorId },
  })
  tools.emit({
    type: 'sample_swatch.changed',
    subject: swatch.id,
    companyId,
    payload: { sampleSwatchId: swatch.id, styleId: swatch.styleId, roundId: swatch.roundId, partyId: swatch.partyId, kind: swatch.kind as SwatchKind, change: 'UPDATED', decision: null, via: null },
  })
  return { sampleSwatchId: swatch.id, decision: null }
}

export const SAMPLE_ROUND_ADAPTER: RecordAdapter = Object.freeze<RecordAdapter>({
  recordType: SAMPLE_ROUND_RECORD,
  kinds: ['SAMPLE'],
  view: SALES_SAMPLES_VIEW,
  ask: SALES_SAMPLES_DECIDE,
  async read(client, recordId): Promise<ApprovalRecord | null> {
    const round = await readRoundRow(client, recordId)
    if (!round) return null
    const waiting = await waitingRequest(client, 'SampleRound', round.id)
    const held = askRefusal({ number: round.number, stage: round.stage as SampleStage, partyId: round.partyId }, waiting)
    return { companyId: round.companyId, siteId: null, partyId: round.partyId, label: roundWords(round), held: held?.message ?? null, thread: { type: SAMPLE_ROUND_RECORD, id: round.id } }
  },
  async fileRecords(client, recordId) {
    const round = await readRoundRow(client, recordId)
    return round ? [{ type: SAMPLE_ROUND_RECORD, id: round.id }, { type: 'Style', id: round.styleId }] : []
  },
  async content(client, request, locale: ApprovalLocale) {
    const round = await readRoundRow(client, request.recordId)
    if (!round) return { facts: [], revisedOrder: null }
    const [style, revision, colourways] = await Promise.all([
      client.style.findUnique({ where: { id: round.styleId }, select: { code: true, name: true } }),
      client.styleRevision.findUnique({ where: { id: round.revisionId }, select: { revision: true } }),
      client.colourway.findMany({ where: { styleId: round.styleId }, select: { id: true, code: true } }),
    ])
    return {
      facts: [
        { label: words(locale, 'Campione', 'Sample'), value: roundWords(round)[locale] },
        { label: words(locale, 'Modello', 'Style'), value: style ? `${style.code} ${style.name}` : '' },
        { label: words(locale, 'Revisione', 'Revision'), value: String(revision?.revision ?? '') },
        { label: words(locale, 'Taglie', 'Sizes'), value: sizesWords(round.cells, new Map(colourways.map((row) => [row.id, row.code]))) },
      ],
      revisedOrder: null,
    }
  },
  async answerHeld(client, request, locale) {
    const round = await readRoundRow(client, request.recordId)
    if (!round) return words(locale, 'Questo campione non è più disponibile.', 'This sample is no longer available.')
    return answerHeldWords({ stage: round.stage as SampleStage, approvalRequestId: round.approvalRequestId }, request.id, locale)
  },
  async onAsked(tools, request) {
    const round = (await readRoundRow(tools.tx, request.recordId))!
    await tools.tx.sampleRound.update({ where: { id: round.id }, data: { approvalRequestId: request.id, version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ action: 'sales.samples.ask', recordType: SAMPLE_ROUND_RECORD, recordId: round.id, companyId: round.companyId, before: { approvalRequestId: round.approvalRequestId }, after: { approvalRequestId: request.id } })
    tools.emit({ type: 'sample_round.asked', subject: round.id, companyId: round.companyId, payload: { sampleRoundId: round.id, number: round.number, approvalRequestId: request.id, partyId: request.partyId } })
  },
  async settle(tools, request): Promise<Prisma.InputJsonObject | null> {
    const answer = await answerOf(tools, request)
    const round = await readRoundRow(tools.tx, request.recordId)
    if (!answer || !round) return null
    if (!isOpenStage(round.stage as SampleStage) || (round.approvalRequestId !== null && round.approvalRequestId !== request.id)) {
      tools.audit({ action: 'sales.samples.answerNotTaken', recordType: SAMPLE_ROUND_RECORD, recordId: round.id, companyId: round.companyId, after: { approvalRequestId: request.id, stage: round.stage, decision: round.decision, answered: answer.decision } })
      return { decided: false, stage: round.stage }
    }
    const { count } = await tools.tx.sampleRound.updateMany({
      where: { id: round.id, version: round.version },
      data: { stage: 'DECIDED', decision: answer.decision, decisionComments: answer.comments, decidedAt: answer.decidedAt, decidedVia: answer.via, decidedById: answer.decidedById, approvalRequestId: request.id, version: { increment: 1 }, updatedAt: tools.now },
    })
    if (count !== 1) return { decided: false, stage: round.stage }
    tools.audit({
      action: 'sales.samples.decide',
      recordType: SAMPLE_ROUND_RECORD,
      recordId: round.id,
      companyId: round.companyId,
      before: { stage: round.stage, decision: null },
      after: { stage: 'DECIDED', decision: answer.decision, decisionComments: answer.comments, decidedAt: toUtcIso(answer.decidedAt), decidedVia: answer.via, decidedById: answer.decidedById, approvalRequestId: request.id, signedAs: answer.typedName },
    })
    tools.emit({
      type: 'sample_round.decided',
      subject: round.id,
      companyId: round.companyId,
      payload: { sampleRoundId: round.id, number: round.number, styleId: round.styleId, revisionId: round.revisionId, kind: round.kind as SampleKind, roundNo: round.roundNo, partyId: round.partyId, decision: answer.decision, via: answer.via, approvalRequestId: request.id },
    })
    return { decided: true, decision: answer.decision, via: answer.via }
  },
  reverseFacts: roundReverseFacts, // B-PR-30b
  reverse: roundReverse, // B-PR-40
})

// ---- swatches -------------------------------------------------------------------------------------------------------------

async function swatchBasics(client: Reader, swatchId: string) {
  const swatch = await readSwatchRow(client, swatchId)
  if (!swatch) return null
  const [companyId, style, item, colour, lot] = await Promise.all([
    swatchCompanyOf(client, swatch),
    client.style.findUnique({ where: { id: swatch.styleId }, select: { code: true, name: true } }),
    client.item.findUnique({ where: { id: swatch.itemId }, select: { code: true, name: true } }),
    swatch.itemColourId ? client.itemColour.findUnique({ where: { id: swatch.itemColourId }, select: { code: true, name: true } }) : Promise.resolve(null),
    swatch.lotId ? client.lot.findUnique({ where: { id: swatch.lotId }, select: { code: true } }) : Promise.resolve(null),
  ])
  const what = `${item?.code ?? ''}${colour ? ` ${colour.code}` : ''}${lot ? ` · lot ${lot.code}` : ''}`
  const kind = swatch.kind as SwatchKind
  // B-PR-29: each kind its own word (colour, leather, fabric, trim).
  const label = { it: `${style?.code ?? ''} · ${SWATCH_WORDS[kind].it} ${what}`, en: `${style?.code ?? ''} · ${SWATCH_WORDS[kind].en} ${what}` }
  return { swatch, companyId, style, item, colour, lot, label }
}

export const SAMPLE_SWATCH_ADAPTER: RecordAdapter = Object.freeze<RecordAdapter>({
  recordType: SAMPLE_SWATCH_RECORD,
  // B-PR-29: a fabric or trim swatch is asked with FABRIC or TRIM (its own kind, as COLOUR and LEATHER).
  kinds: ['COLOUR', 'LEATHER', 'FABRIC', 'TRIM'],
  view: SALES_SAMPLES_VIEW,
  ask: SALES_SAMPLES_DECIDE,
  async read(client, recordId, kind): Promise<ApprovalRecord | null> {
    const basics = await swatchBasics(client, recordId)
    if (!basics) return null
    const { swatch, companyId, style, label } = basics
    const waiting = await waitingRequest(client, 'SampleSwatch', swatch.id)
    const held = companyId === null ? noCompanyRefusal(style?.code ?? '') : swatchAskRefusal(swatchFacts(swatch), kind, waiting)
    return {
      companyId: companyId ?? '',
      siteId: null,
      partyId: swatch.partyId,
      label,
      held: held?.message ?? null,
      thread: swatch.roundId ? { type: SAMPLE_ROUND_RECORD, id: swatch.roundId } : { type: 'Style', id: swatch.styleId },
    }
  },
  async fileRecords(client, recordId) {
    const swatch = await readSwatchRow(client, recordId)
    if (!swatch) return []
    return [{ type: SAMPLE_SWATCH_RECORD, id: swatch.id }, ...(swatch.roundId ? [{ type: SAMPLE_ROUND_RECORD, id: swatch.roundId }] : []), { type: 'Style', id: swatch.styleId }]
  },
  async content(client, request, locale: ApprovalLocale) {
    const basics = await swatchBasics(client, request.recordId)
    if (!basics) return { facts: [], revisedOrder: null }
    const { swatch, style, item, colour, lot } = basics
    return {
      facts: [
        { label: words(locale, 'Modello', 'Style'), value: style ? `${style.code} ${style.name}` : '' },
        { label: words(locale, 'Materiale', 'Material'), value: item ? `${item.code} ${item.name}` : '' },
        ...(colour ? [{ label: words(locale, 'Colore', 'Colour'), value: `${colour.code} ${colour.name}` }] : []),
        ...(lot ? [{ label: words(locale, 'Lotto', 'Lot'), value: lot.code }] : []),
        ...(swatch.sentAt ? [{ label: words(locale, 'Inviato il', 'Sent on'), value: businessDate(swatch.sentAt) }] : []),
      ],
      revisedOrder: null,
    }
  },
  async answerHeld(client, request, locale) {
    const swatch = await readSwatchRow(client, request.recordId)
    if (!swatch) return words(locale, 'Questo campione non è più disponibile.', 'This swatch is no longer available.')
    return swatchAnswerHeldWords(swatch, request.id, locale)
  },
  async onAsked(tools, request) {
    const swatch = (await readSwatchRow(tools.tx, request.recordId))!
    const companyId = await swatchCompanyOf(tools.tx, swatch)
    await tools.tx.sampleSwatch.update({ where: { id: swatch.id }, data: { approvalRequestId: request.id, version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ action: 'sales.samples.swatchAsk', recordType: SAMPLE_SWATCH_RECORD, recordId: swatch.id, companyId, before: { approvalRequestId: swatch.approvalRequestId }, after: { approvalRequestId: request.id, kind: request.kind } })
    tools.emit({
      type: 'sample_swatch.changed',
      subject: swatch.id,
      companyId,
      payload: { sampleSwatchId: swatch.id, styleId: swatch.styleId, roundId: swatch.roundId, partyId: swatch.partyId, kind: swatch.kind as SwatchKind, change: 'ASKED', decision: null, via: null },
    })
  },
  async settle(tools, request): Promise<Prisma.InputJsonObject | null> {
    const answer = await answerOf(tools, request)
    const swatch = await readSwatchRow(tools.tx, request.recordId)
    if (!answer || !swatch) return null
    const companyId = await swatchCompanyOf(tools.tx, swatch)
    if (swatch.decision !== null || (swatch.approvalRequestId !== null && swatch.approvalRequestId !== request.id)) {
      tools.audit({ action: 'sales.samples.answerNotTaken', recordType: SAMPLE_SWATCH_RECORD, recordId: swatch.id, companyId, after: { approvalRequestId: request.id, decision: swatch.decision, answered: answer.decision } })
      return { decided: false }
    }
    const { count } = await tools.tx.sampleSwatch.updateMany({
      where: { id: swatch.id, version: swatch.version },
      data: { decision: answer.decision, decisionComments: answer.comments, decidedAt: answer.decidedAt, decidedVia: answer.via, decidedById: answer.decidedById, approvalRequestId: request.id, version: { increment: 1 }, updatedAt: tools.now },
    })
    if (count !== 1) return { decided: false }
    tools.audit({
      action: 'sales.samples.swatchDecide',
      recordType: SAMPLE_SWATCH_RECORD,
      recordId: swatch.id,
      companyId,
      before: { decision: null },
      after: { decision: answer.decision, decisionComments: answer.comments, decidedAt: toUtcIso(answer.decidedAt), decidedVia: answer.via, decidedById: answer.decidedById, approvalRequestId: request.id, signedAs: answer.typedName },
    })
    tools.emit({
      type: 'sample_swatch.changed',
      subject: swatch.id,
      companyId,
      payload: { sampleSwatchId: swatch.id, styleId: swatch.styleId, roundId: swatch.roundId, partyId: swatch.partyId, kind: swatch.kind as SwatchKind, change: 'DECIDED', decision: answer.decision, via: answer.via },
    })
    return { decided: true, decision: answer.decision, via: answer.via }
  },
  reverseFacts: swatchReverseFacts, // B-PR-30b
  reverse: swatchReverse, // B-PR-40
})

export const SAMPLE_DECISION_ADAPTERS: readonly RecordAdapter[] = Object.freeze([SAMPLE_ROUND_ADAPTER, SAMPLE_SWATCH_ADAPTER])
