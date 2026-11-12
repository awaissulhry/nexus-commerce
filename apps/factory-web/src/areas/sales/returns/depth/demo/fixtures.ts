import { PEOPLE, RMA_AUTHORISED, RMA_INSPECTED, RMA_RECEIVED } from '../../demo/fixtures'
import type { Rma } from '../../api'
import type { FeePreview, PolicyCheck, ReturnDepth, ReturnOutcomes } from '../api'
import type { RmaDepthModel } from '../view-model'

/**
 * Made-up data of the W2b parts of a return (B-W2b-352 design cases of SCR-111 and SCR-112): a "Demo" policy and fee rule,
 * the RMAs of demo/fixtures.ts in depth, their outcomes, a fee preview and a policy check. Nothing here is a real company,
 * person, garment, price or return.
 */

const POLICY = {
  id: '0190f0e2-7790-7000-8000-000000000001',
  companyId: RMA_AUTHORISED.companyId,
  channel: 'B2B' as const,
  name: 'Demo returns policy 2026',
  windowDays: 30,
  goodsDueDays: 15,
  freightPaidBy: 'BY_CAUSE' as const,
  conditions: 'Unworn, with labels (made-up).',
  withdrawalWords: null,
  effectiveFrom: '2026-01-01',
  live: true,
  version: 1,
}

const window = (deliveredOn: string, lastDay: string, daysOver = 0) => ({ deliveredOn, lastDay, inWindow: daysOver === 0, daysOver })

export const POLICY_CHECK: PolicyCheck = {
  channel: 'B2B',
  channelFrom: 'CUSTOMER',
  policy: POLICY,
  fallback: null,
  lines: [
    { index: 0, seq: 10, window: window('2026-10-05', '2026-11-04'), madeToMeasure: false, personalised: false },
    { index: 1, seq: 20, window: window('2026-10-05', '2026-11-04'), madeToMeasure: false, personalised: false },
  ],
  outsideWindow: false,
  withdrawal: { asked: false, applies: false },
  goodsDueBy: '2026-11-13',
  warnings: [],
  problems: [],
  ok: true,
}

const credit = (allowed: boolean, over: Partial<ReturnDepth['lines'][number]['creditWithoutReturn']> = {}) => ({ credited: false, waiting: null, allowed, ...over })

function depthOf(rma: Rma, over: Partial<ReturnDepth> = {}): ReturnDepth {
  return {
    id: rma.id,
    number: rma.number,
    status: rma.status,
    companyId: rma.companyId,
    partyId: rma.partyId,
    channel: 'B2B',
    policy: { named: POLICY, live: POLICY, current: true, withdrawal: false, followsSalesSettings: false, check: POLICY_CHECK },
    deadline: { goodsDueBy: rma.goodsDueBy, receivedOn: rma.receivedAt ? rma.receivedAt.slice(0, 10) : null, arrival: rma.receivedAt ? { state: 'ON_TIME', daysLate: 0 } : { state: 'WAITING', daysLate: 0 } },
    scanCode: null,
    papers: { printable: false },
    feesApply: true,
    lines: rma.lines.map((line, index) => ({
      id: line.id,
      seq: line.seq,
      size: line.size,
      quantity: line.quantity,
      receivedQuantity: line.receivedQuantity,
      serial: line.serial,
      batchNumber: line.batchNumber,
      garmentSerial: null,
      garmentBatch: line.batchNumber,
      parentLineId: null,
      exchangeSize: null,
      window: POLICY_CHECK.lines[index]?.window ?? null,
      currency: 'EUR',
      value: index === 0 ? 25000 : 32400,
      creditAmount: line.creditAmount,
      creditWithoutReturn: credit(false),
      fee: null,
    })),
    version: rma.version,
    ...over,
  }
}

/** Authorised: no policy bound yet (the sales settings apply) while one is live; both lines may be credited without the goods. */
export const DEPTH_AUTHORISED: ReturnDepth = {
  ...depthOf(RMA_AUTHORISED),
  policy: { named: null, live: POLICY, current: false, withdrawal: false, followsSalesSettings: true, check: POLICY_CHECK },
  feesApply: false,
  lines: depthOf(RMA_AUTHORISED).lines.map((line) => ({ ...line, creditWithoutReturn: credit(true) })),
}

/** Received on time, the policy bound and a scan code set. */
export const DEPTH_RECEIVED: ReturnDepth = { ...depthOf(RMA_RECEIVED), scanCode: 'RMA-DEMO-0001', papers: { printable: true } }

/** The received RMA whose deadline was 27 October: its goods came three days late. */
export const RMA_RECEIVED_LATE: Rma = { ...RMA_RECEIVED, goodsDueBy: '2026-10-27' }
export const DEPTH_RECEIVED_LATE: ReturnDepth = { ...DEPTH_RECEIVED, deadline: { goodsDueBy: '2026-10-27', receivedOn: '2026-10-30', arrival: { state: 'LATE', daysLate: 3 } } }

/** Inspected: line 10's fee dropped (the cause is ours), line 20's restocking fee withheld from its credit. */
export const DEPTH_INSPECTED: ReturnDepth = {
  ...depthOf(RMA_INSPECTED),
  scanCode: 'RMA-DEMO-0001',
  papers: { printable: true },
  lines: depthOf(RMA_INSPECTED).lines.map((line, index) =>
    index === 0 ? { ...line, fee: { ruleId: 'demo-rule', ruleName: 'Restocking 10%', amount: 0, dropped: 'OUR_CAUSE' } } : { ...line, creditAmount: 32400, fee: { ruleId: 'demo-rule', ruleName: 'Restocking 10%', amount: 3600, dropped: null } },
  ),
}

/** A credit without the goods waiting for a yes (line 10), and line 20 credited (the authorised RMA). */
export const DEPTH_CREDIT_WAITING: ReturnDepth = {
  ...DEPTH_AUTHORISED,
  policy: { ...depthOf(RMA_AUTHORISED).policy },
  feesApply: true,
  lines: DEPTH_AUTHORISED.lines.map((line, index) =>
    index === 0
      ? { ...line, creditWithoutReturn: credit(false, { waiting: { taskId: 'demo-task-1', requestedAt: '2026-10-31T08:10:00.000Z', approverRoleId: null, approverUserId: PEOPLE[1]!.id, dueAt: null } }) }
      : { ...line, creditAmount: 32400, creditWithoutReturn: credit(false, { credited: true }) },
  ),
}

function outcomesOf(rma: Rma, over: Partial<ReturnOutcomes> = {}): ReturnOutcomes {
  return {
    id: rma.id,
    number: rma.number,
    status: rma.status,
    channel: 'OFFICE',
    remake: { asked: false, at: null, via: null, lineIds: [], fit: null, photos: [] },
    lines: rma.lines.map((line) => ({
      id: line.id,
      seq: line.seq,
      description: line.description,
      size: line.size,
      quantity: line.quantity,
      receivedQuantity: line.receivedQuantity,
      expected: Math.max(0, line.quantity - line.receivedQuantity),
      graded: line.grade !== null,
      disposition: line.disposition,
      goodsOutcome: line.goodsOutcome,
      exchangeSize: null,
      replacementLineId: null,
      creditWithoutReturn: false,
      parentLineId: null,
      splitLineIds: [],
      split: { allowed: false, rest: 0 },
      exchange: { sizes: line.size === '52' ? ['50', '54', '56'] : ['48', '52'] },
      remake: false,
      photos: line.photos,
      version: line.version,
    })),
    finish: { reasons: [], suggested: null, missingPieces: 0, finishReason: null, closedAt: null },
    version: rma.version,
    ...over,
  }
}

const FINISH_ALLOWED: ReturnOutcomes['finish'] = {
  reasons: [
    { reason: 'COMPLETED', allowed: true },
    { reason: 'CREDITED_WITHOUT_RETURN', allowed: false },
    { reason: 'RETURNED_UNCHANGED', allowed: false },
    { reason: 'GOODS_NOT_RECEIVED', allowed: false },
    { reason: 'CUSTOMER_WITHDREW', allowed: false },
    { reason: 'OTHER', allowed: true },
  ],
  suggested: 'COMPLETED',
  missingPieces: 0,
  finishReason: null,
  closedAt: null,
}

export const OUTCOMES_AUTHORISED = outcomesOf(RMA_AUTHORISED)
export const OUTCOMES_RECEIVED = outcomesOf(RMA_RECEIVED)
export const OUTCOMES_INSPECTED = outcomesOf(RMA_INSPECTED, { finish: FINISH_ALLOWED })

/** Received: line 20 sent 2, 1 arrived — the rest may be split off. */
export const RMA_PART_RECEIVED: Rma = { ...RMA_RECEIVED, lines: [RMA_RECEIVED.lines[0]!, { ...RMA_RECEIVED.lines[1]!, receivedQuantity: 1, receivedValue: 16200 }] }
export const OUTCOMES_PART_RECEIVED: ReturnOutcomes = {
  ...outcomesOf(RMA_PART_RECEIVED),
  lines: outcomesOf(RMA_PART_RECEIVED).lines.map((line, index) => (index === 1 ? { ...line, split: { allowed: true, rest: 1 } } : line)),
}

/** A remake asked through a claim link: line 10, the fit in the customer's words, one photo of the two asked. */
export const OUTCOMES_REMAKE: ReturnOutcomes = {
  ...OUTCOMES_AUTHORISED,
  remake: { asked: true, at: '2026-10-30T16:20:00.000Z', via: 'LINK', lineIds: [RMA_AUTHORISED.lines[0]!.id], fit: 'Sleeves 3 cm too short (made-up).', photos: [{ lineId: RMA_AUTHORISED.lines[0]!.id, count: 1, needed: 2 }] },
}

/** The fees of the decisions drafted on the received RMA (line 20 restocked with its credit; line 10's cause is ours). */
export const FEES_DRAFTED: FeePreview = {
  policyNamed: true,
  lines: [{ lineId: RMA_RECEIVED.lines[1]!.id, seq: 20, currency: 'EUR', creditBefore: 32400, fee: { ruleId: 'demo-rule', ruleName: 'Restocking 10%', amount: 3240, dropped: null }, creditAfter: 29160 }],
}

export function depthModel(over: Partial<RmaDepthModel> = {}): RmaDepthModel {
  return { depth: { value: DEPTH_AUTHORISED, problem: null }, outcomes: { value: OUTCOMES_AUTHORISED, problem: null }, fees: null, dialog: null, busy: false, problem: null, printing: false, ...over }
}
