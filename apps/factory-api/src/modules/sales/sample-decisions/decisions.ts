import { PARTNERS_APPROVALS_ASK } from '@nexus/factory-domain/approvals-out/permissions'
import { CERTIFICATES_MANAGE } from '@nexus/factory-domain/compliance/certificates/permissions'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { PRODUCT_CHANGES_REQUEST, PRODUCT_CHANGES_VIEW } from '@nexus/factory-domain/product/changes/permissions'
import type { ApprovalView, DecisionBody, NextRoundBody, TestResultBody } from '@nexus/factory-domain/sales/sample-decisions/contracts'
import { SALES_SAMPLES_DECIDE } from '@nexus/factory-domain/sales/sample-decisions/permissions'
import {
  askRefusal,
  certificateCoverRefusal,
  decisionProblems,
  decisionRefusal,
  nextRoundRefusal,
  testResultRefusal,
} from '@nexus/factory-domain/sales/sample-decisions/rules'
import type { RoundView } from '@nexus/factory-domain/sales/samples/contracts'
import { SALES_SAMPLES_MANAGE } from '@nexus/factory-domain/sales/samples/permissions'
import { cellsOf, SAMPLE_LIMITS, type SampleDecision, type SampleKind, type SampleStage } from '@nexus/factory-domain/sales/samples/rules'
import { command, type CommandCaller } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { createRound } from '../samples/rounds'
import { databaseRefusal, officeRound, readRoundRow, type Reader, type RoundData } from '../samples/store'
import { action, lacking, namesOf, refuse, requireOn, stale, SWATCH_COLUMNS, swatchViewsOf, waitingRequest } from './store'

/**
 * The decision of a sample round (B-W2b-252; SAL-312 "approved, approved with comments, rejected, by whom and on which
 * revision"; PRD-158 certification test samples; design products.samples › the round's Approval tab, "Decide on the
 * sample", "Rejected → Make round 3 with the reason"):
 *
 *   GET  /sales/samples/rounds/:roundId/approval     sales.samples.view: the decision as recorded (by whom: the office user, the
 *                                                    brand's portal person or its link; the typed name; the revision), the
 *                                                    brand's latest request, the round's swatches, the CE test sample, the
 *                                                    change requests it raised, and what may happen now (each action allowed
 *                                                    or refused in words, with the permission it needs)
 *   POST /sales/samples/rounds/:roundId/decision     sales.samples.decide: the office records it (the brand's word by mail or
 *                                                    phone, or our own on an internal round); not while the brand is asked
 *   POST /sales/samples/rounds/:roundId/next-round   sales.samples.manage: after a rejection, round N+1 of the same kind for the
 *                                                    same brand with the same cells (B-W2b-246's create)
 *   POST /sales/samples/rounds/:roundId/test-result  compliance.certificates.manage: a CE test sample's result at the notified
 *                                                    body and the certificate it led to (one that covers the style), each once
 *
 * The brand is asked with the approvals engine (POST /approvals-out {kind SAMPLE, recordType SampleRound, …}); its answer
 * becomes the decision in ./approvals.ts. Each write is ONE command on the round at the version the caller read.
 */

/** The round's latest approval request to its brand. */
async function latestRequest(db: Reader, roundId: string) {
  return db.approvalRequest.findFirst({
    where: { recordType: 'SampleRound', recordId: roundId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, status: true, dueAt: true, answeredAt: true, createdAt: true, version: true },
  })
}

async function approvalViewOf(db: Reader, context: OfficeContext, round: RoundData): Promise<ApprovalView> {
  const scope = { companyId: round.companyId, partyId: round.partyId }
  const [revision, request, waiting, swatchRows, answer] = await Promise.all([
    db.styleRevision.findUniqueOrThrow({ where: { id: round.revisionId }, select: { id: true, revision: true, status: true } }),
    latestRequest(db, round.id),
    waitingRequest(db, 'SampleRound', round.id),
    db.sampleSwatch.findMany({ where: { roundId: round.id }, select: SWATCH_COLUMNS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
    round.approvalRequestId && round.decidedVia !== 'OFFICE' ? db.approvalRequest.findUnique({ where: { id: round.approvalRequestId }, select: { typedName: true } }) : Promise.resolve(null),
  ])
  const names = await namesOf(db, [round.decidedById])
  const kind = round.kind as SampleKind
  let certification: ApprovalView['certification'] = null
  if (kind === 'CERTIFICATION') {
    const [shipments, certificate] = await Promise.all([
      db.sampleShipment.findMany({ where: { roundId: round.id, direction: 'OUTBOUND' }, select: { partyId: true, sentAt: true, receivedAt: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
      round.certificateId ? db.certificate.findUnique({ where: { id: round.certificateId }, select: { id: true, number: true, standard: true, notifiedBodyNumber: true, validTo: true, status: true } }) : Promise.resolve(null),
    ])
    const parties = new Map((await db.party.findMany({ where: { id: { in: [...new Set(shipments.map((row) => row.partyId))] } }, select: { id: true, code: true, legalName: true, tradeName: true } })).map((row) => [row.id, row]))
    certification = {
      sentTo: shipments.map((row) => {
        const party = parties.get(row.partyId)
        return { id: row.partyId, code: party?.code ?? '', name: party ? (party.tradeName ?? party.legalName) : '', sentAt: row.sentAt ? toUtcIso(row.sentAt) : null, receivedAt: row.receivedAt ? toUtcIso(row.receivedAt) : null }
      }),
      testZones: round.testZones,
      testResult: round.testResult,
      certificate: certificate ? { ...certificate, validTo: certificate.validTo.toISOString().slice(0, 10) } : null,
    }
  }
  const changes = lacking(context, [PRODUCT_CHANGES_VIEW], { companyId: round.companyId, partyId: null }) === null
  const changeRequests = changes
    ? await db.changeRequest.findMany({ where: { sampleRoundId: round.id }, select: { id: true, number: true, status: true, title: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
    : null
  const facts = { number: round.number, stage: round.stage as SampleStage, partyId: round.partyId }
  const decision = round.decision as SampleDecision | null
  const testFacts = { number: round.number, kind, testResult: round.testResult, certificateId: round.certificateId }
  return {
    round: { id: round.id, number: round.number, kind, roundNo: round.roundNo, stage: round.stage as SampleStage, partyId: round.partyId, styleId: round.styleId, revision, version: round.version },
    decision:
      decision && round.decidedAt && round.decidedVia
        ? {
            decision,
            comments: round.decisionComments,
            at: toUtcIso(round.decidedAt),
            via: round.decidedVia,
            by: round.decidedById ? { id: round.decidedById, name: names.get(round.decidedById) ?? '' } : null,
            signedAs: answer?.typedName ?? null,
            revision: revision.revision,
          }
        : null,
    request: request ? { id: request.id, status: request.status, dueAt: toUtcIso(request.dueAt), answeredAt: request.answeredAt ? toUtcIso(request.answeredAt) : null, createdAt: toUtcIso(request.createdAt), version: request.version } : null,
    swatches: await swatchViewsOf(db, context, swatchRows),
    certification,
    changeRequests,
    actions: {
      decide: action(lacking(context, [SALES_SAMPLES_DECIDE], scope), decisionRefusal(facts, waiting)),
      askBrand: action(lacking(context, [SALES_SAMPLES_DECIDE, PARTNERS_APPROVALS_ASK], scope), askRefusal(facts, waiting)),
      nextRound: action(lacking(context, [SALES_SAMPLES_MANAGE], scope), nextRoundRefusal({ number: round.number, decision })),
      testResult: action(
        lacking(context, [CERTIFICATES_MANAGE], { companyId: round.companyId, partyId: null }),
        // A certification round with both written answers RESULT_ONCE (asked as if the result changed); any other round CERTIFICATION_ONLY.
        kind !== 'CERTIFICATION' || (round.testResult !== null && round.certificateId !== null) ? testResultRefusal(testFacts, { testResult: round.testResult === 'PASSED' ? 'FAILED' : 'PASSED' }) : null,
      ),
      raiseChangeRequest: action(lacking(context, [PRODUCT_CHANGES_REQUEST], { companyId: round.companyId, partyId: null }), null),
    },
  }
}

/** GET /sales/samples/rounds/:roundId/approval */
export async function readApproval(caller: CommandCaller, roundId: string): Promise<ApprovalView> {
  const { context, round } = await officeRound(caller, roundId)
  return caller.withClient((db) => approvalViewOf(db, context, round))
}

/** POST /sales/samples/rounds/:roundId/decision: the office records the decision on the round's pinned revision. */
export async function decideRound(caller: CommandCaller, roundId: string, body: DecisionBody, idempotencyKey?: string): Promise<ApprovalView> {
  const { context, round: seen } = await officeRound(caller, roundId)
  requireOn(context, SALES_SAMPLES_DECIDE, { companyId: seen.companyId, partyId: seen.partyId }, "Your role does not record sample decisions for this company or customer")
  const problems = decisionProblems(body.decision, body.comments)
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  const waiting = await caller.withClient((db) => waitingRequest(db, 'SampleRound', roundId))
  refuse(decisionRefusal({ number: seen.number, stage: seen.stage as SampleStage, partyId: seen.partyId }, waiting))
  await command(caller, { name: 'sales.samples.decide', idempotencyKey, input: { roundId, ...body }, record: { type: 'SampleRound', id: roundId, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    const row = (await readRoundRow(tx, roundId))!
    refuse(decisionRefusal({ number: row.number, stage: row.stage as SampleStage, partyId: row.partyId }, await waitingRequest(tx, 'SampleRound', roundId)))
    const comments = body.comments ?? null
    await tx.sampleRound.update({ where: { id: roundId }, data: { stage: 'DECIDED', decision: body.decision, decisionComments: comments, decidedAt: now, decidedVia: 'OFFICE', decidedById: context.actorId, updatedAt: now }, select: { id: true } })
    const revision = await tx.styleRevision.findUniqueOrThrow({ where: { id: row.revisionId }, select: { revision: true } })
    tools.audit({
      action: 'sales.samples.decide',
      recordType: 'SampleRound',
      recordId: roundId,
      companyId: row.companyId,
      before: { stage: row.stage, decision: null },
      after: { stage: 'DECIDED', decision: body.decision, decisionComments: comments, decidedAt: toUtcIso(now), decidedVia: 'OFFICE', decidedById: context.actorId, revision: revision.revision },
    })
    tools.emit({
      type: 'sample_round.decided',
      subject: roundId,
      companyId: row.companyId,
      payload: { sampleRoundId: roundId, number: row.number, styleId: row.styleId, revisionId: row.revisionId, kind: row.kind as SampleKind, roundNo: row.roundNo, partyId: row.partyId, decision: body.decision, via: 'OFFICE', approvalRequestId: row.approvalRequestId },
    })
    return null
  }).catch(databaseRefusal)
  return readApproval(caller, roundId)
}

/** POST /sales/samples/rounds/:roundId/next-round: round N+1 after a rejection (B-W2b-246's create, its checks and numbering). */
export async function nextRound(caller: CommandCaller, roundId: string, body: NextRoundBody, idempotencyKey?: string): Promise<RoundView> {
  const { context, round } = await officeRound(caller, roundId)
  requireOn(context, SALES_SAMPLES_MANAGE, { companyId: round.companyId, partyId: round.partyId }, 'Your role does not ask for sample rounds for this company or customer')
  if (body.version !== undefined && body.version !== round.version) throw stale(`Sample round ${round.number}`, round.version)
  refuse(nextRoundRefusal({ number: round.number, decision: round.decision as SampleDecision | null }))
  const why = `Round ${round.roundNo} (${round.number}) rejected: ${round.decisionComments ?? ''}`.trim().slice(0, SAMPLE_LIMITS.instructions)
  const cells = cellsOf(round.cells).map((cell) => ({ ...(cell.colourwayId ? { colourwayId: cell.colourwayId } : {}), size: cell.size, quantity: cell.quantity }))
  return createRound(
    caller,
    {
      styleId: round.styleId,
      companyId: round.companyId,
      kind: round.kind as SampleKind,
      ...(round.partyId ? { partyId: round.partyId } : {}),
      ...(body.revisionId ? { revisionId: body.revisionId } : {}),
      cells,
      ...(body.dueDate ? { dueDate: body.dueDate } : {}),
      instructions: body.instructions ?? why,
      ...(round.testZones ? { testZones: round.testZones } : {}),
    },
    idempotencyKey,
  )
}

/** POST /sales/samples/rounds/:roundId/test-result: the notified body's result and the certificate, each written once. */
export async function recordTestResult(caller: CommandCaller, roundId: string, body: TestResultBody, idempotencyKey?: string): Promise<ApprovalView> {
  const { context, round: seen } = await officeRound(caller, roundId)
  requireOn(context, CERTIFICATES_MANAGE, { companyId: seen.companyId, partyId: null }, 'Recording a CE test sample\'s result is for whoever keeps certificates')
  if (body.testResult === undefined && body.certificateId === undefined) {
    throw new ValidationError('Say the result or the certificate.', [{ path: 'body/testResult', message: 'Say the result or the certificate.' }])
  }
  const change = { ...(body.testResult !== undefined ? { testResult: body.testResult } : {}), ...(body.certificateId !== undefined ? { certificateId: body.certificateId } : {}) }
  refuse(testResultRefusal({ number: seen.number, kind: seen.kind as SampleKind, testResult: seen.testResult, certificateId: seen.certificateId }, change))
  if (body.certificateId) {
    await caller.withClient(async (db) => {
      const certificate = await db.certificate.findUnique({ where: { id: body.certificateId }, select: { id: true, number: true, companyId: true } })
      if (!certificate || (certificate.companyId !== null && certificate.companyId !== seen.companyId)) {
        throw new ValidationError('No such certificate for this company.', [{ path: 'body/certificateId', message: 'No such certificate for this company.' }])
      }
      const covers = await db.certificateCoverage.findFirst({ where: { certificateId: certificate.id, styleId: seen.styleId }, select: { id: true } })
      if (!covers) {
        const style = await db.style.findUnique({ where: { id: seen.styleId }, select: { code: true } })
        refuse(certificateCoverRefusal(certificate.number, style?.code ?? ''))
      }
    })
  }
  await command(caller, { name: 'sales.samples.testResult', idempotencyKey, input: { roundId, ...body }, record: { type: 'SampleRound', id: roundId, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    const row = (await readRoundRow(tx, roundId))!
    refuse(testResultRefusal({ number: row.number, kind: row.kind as SampleKind, testResult: row.testResult, certificateId: row.certificateId }, change))
    const data = { ...(change.testResult !== undefined && change.testResult !== row.testResult ? { testResult: change.testResult } : {}), ...(change.certificateId !== undefined && change.certificateId !== row.certificateId ? { certificateId: change.certificateId } : {}) }
    await tx.sampleRound.update({ where: { id: roundId }, data: { ...data, updatedAt: now }, select: { id: true } })
    tools.audit({ action: 'sales.samples.testResult', recordType: 'SampleRound', recordId: roundId, companyId: row.companyId, before: { testResult: row.testResult, certificateId: row.certificateId }, after: { testResult: data.testResult ?? row.testResult, certificateId: data.certificateId ?? row.certificateId } })
    tools.emit({
      type: 'sample_round.test_recorded',
      subject: roundId,
      companyId: row.companyId,
      payload: { sampleRoundId: roundId, number: row.number, testResult: (data.testResult ?? row.testResult) as 'PASSED' | 'FAILED' | null, certificateId: data.certificateId ?? row.certificateId },
    })
    return null
  }).catch(databaseRefusal)
  return readApproval(caller, roundId)
}
