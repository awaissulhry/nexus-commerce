import type { Prisma } from '@nexus/factory-db'
import { SAMPLE_ROUND_RECORD, SAMPLE_SWATCH_RECORD, type ApprovalLocale } from '@nexus/factory-domain/approvals-out/kinds'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { SALES_SAMPLES_DECIDE } from '@nexus/factory-domain/sales/sample-decisions/permissions'
import { answerHeldWords, askRefusal, decisionOfAnswer, noCompanyRefusal, swatchAnswerHeldWords, swatchAskRefusal, type SwatchKind } from '@nexus/factory-domain/sales/sample-decisions/rules'
import { SALES_SAMPLES_VIEW } from '@nexus/factory-domain/sales/samples/permissions'
import { cellsOf, isOpenStage, roundLabel, type SampleKind, type SampleStage } from '@nexus/factory-domain/sales/samples/rules'
import type { CommandTools } from '../../../core/command'
import { words, type ApprovalRecord, type RecordAdapter, type RequestRef } from '../../../platform/approvals-out/adapter'
import { readRoundRow, type Reader } from '../samples/store'
import { readSwatchRow, swatchCompanyOf, swatchFacts, waitingRequest } from './store'

/**
 * The brand decides a sample round or a swatch through the approvals engine (B-W2b-184; B-W2b-252 SAL-312, SAL-314; design
 * products.samples › Approval "Ask the customer (Links › Approve)"; links.approve "Sample, colour, leather: photos and spec,
 * comments with photo markup"): the office asks with POST /approvals-out {kind SAMPLE, recordType SampleRound} or {kind
 * COLOUR | LEATHER (the swatch's own), recordType SampleSwatch}, sales.samples.decide + partners.approvals.ask over the
 * round's company and brand; the brand answers by its link or in its portal, once.
 *
 *   read       the round (its company, its brand, "SR-2026-0003 · Fit · round 2"), held while it may not be asked (internal,
 *              only requested, decided, cancelled, asked already) — a swatch: once sent, not decided, its own kind
 *   onAsked    in the office's ask command: the round or swatch names its request (approvalRequestId), sample_round.asked /
 *              sample_swatch.changed ASKED
 *   answerHeld the round or swatch was decided or cancelled meanwhile, or a newer request was sent: the brand's answer is not
 *              taken ("This sample is decided already.")
 *   settle     in the tenant's SYSTEM scope right after the partner's answer (the partner role writes neither table): the
 *              answer becomes the decision — APPROVED, APPROVED_WITH_CHANGES → APPROVED_WITH_COMMENTS, REFUSED → REJECTED;
 *              the comments are the brand's words; decidedAt = the answer's time; PORTAL (decidedById = the portal person) or
 *              LINK (nobody named); a round goes DECIDED — the database checks it is that request's answer. A round or
 *              swatch decided meanwhile in the office keeps its decision (the settle says so in its audit row).
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
  const row = await tools.tx.approvalRequest.findUnique({ where: { id: request.id }, select: { status: true, answer: true, typedName: true, answeredAt: true, answeredByUserId: true, answeredViaLinkId: true } })
  const decision = row ? decisionOfAnswer(row.status) : null
  if (!row || !decision || !row.answeredAt) return null
  const via = row.answeredViaLinkId ? ('LINK' as const) : ('PORTAL' as const)
  // A refusal and an approval with changes always carry the brand's words (approvals-out answerProblems); a word for safety.
  const comments = row.answer?.trim() || (decision === 'APPROVED' ? null : 'No words given.')
  return { decision, via, comments, decidedAt: row.answeredAt, decidedById: via === 'PORTAL' ? row.answeredByUserId : null, typedName: row.typedName }
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
  const label = { it: `${style?.code ?? ''} · ${kind === 'LEATHER' ? 'pellame' : 'colore'} ${what}`, en: `${style?.code ?? ''} · ${kind === 'LEATHER' ? 'leather' : 'colour'} ${what}` }
  return { swatch, companyId, style, item, colour, lot, label }
}

export const SAMPLE_SWATCH_ADAPTER: RecordAdapter = Object.freeze<RecordAdapter>({
  recordType: SAMPLE_SWATCH_RECORD,
  kinds: ['COLOUR', 'LEATHER'],
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
        ...(swatch.sentAt ? [{ label: words(locale, 'Inviato il', 'Sent on'), value: swatch.sentAt.toISOString().slice(0, 10) }] : []),
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
})

export const SAMPLE_DECISION_ADAPTERS: readonly RecordAdapter[] = Object.freeze([SAMPLE_ROUND_ADAPTER, SAMPLE_SWATCH_ADAPTER])
