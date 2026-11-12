import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { SALES_RETURNS_VIEW } from '@nexus/factory-domain/sales/returns/permissions'
import { arrivalOf, channelOfParty, CREDIT_WITHOUT_RETURN_STATUSES, creditWithoutReturnProblems, DEPTH_LIMITS, feeOf, feeTermsWords, feeWithAmount, type PolicyChannel } from '@nexus/factory-domain/sales/returns-depth/rules'
import type { ReturnCause, ReturnStatus } from '@nexus/factory-domain/sales/returns/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { CREDIT_WITHOUT_RETURN_RECORD } from '../../../platform/approvals/kinds/credit-without-return'
import { officeOf, officeReturn } from '../returns/access'
import { currencyOf, dayOrNull, lineKeyOf, lineValue, readLines, readRma, soldFactsOf, type Reader, type RmaRow } from '../returns/store'
import { checkPolicy } from './policy-check'
import { FEE_RULE_COLUMNS, feeRuleLike, livePolicyOf, POLICY_COLUMNS, policyUse, policyView, type FeeRuleRow } from './store'

/**
 * A return in depth (B-W2b-341), the reads the W2b screens of Sales › Returns build on (B-W2b-352): the policy it was
 * checked against and the one live now, a consumer's withdrawal, the deadline and whether the goods arrived after it
 * (SAL-337), each line's serial and lot of ours (SAL-336), its window, whether it may be credited without the goods and the
 * yes it waits for (SAL-342), the fee withheld from its credit (SAL-343), the scan code its papers print (SAL-346). Money
 * only with the price grain.
 *
 *   GET /sales/returns/:returnId/depth                 (sales.returns.view) the return in depth
 *   GET /sales/returns/arrived-late?companyId&view     (sales.returns.view) the tile "Arrived after the deadline": returns
 *                                                      whose first receipt (its Rome day) came after the deadline, open
 *                                                      ones (received, inspected) or every one (closed too); at most 200
 */

/** The record's depth. */
export async function returnDepth(caller: CommandCaller, returnId: string) {
  const { rma } = await officeReturn(caller, returnId, SALES_RETURNS_VIEW)
  return { return: await caller.withClient((client) => depthOf(client, rma)) }
}

export async function depthOf(db: Reader, rma: RmaRow) {
  const now = serverClock.now()
  const today = businessDate(now)
  const party = await db.party.findUnique({ where: { id: rma.partyId }, select: { kind: true } })
  const named = rma.policyId ? await db.returnPolicy.findUnique({ where: { id: rma.policyId }, select: POLICY_COLUMNS }) : null
  const channel: PolicyChannel = (named?.channel as PolicyChannel | undefined) ?? channelOfParty(party?.kind ?? 'ORGANISATION')
  const live = await livePolicyOf(db, rma.companyId, channel)
  const used = await policyUse(db, [named?.id, live?.id].filter((id): id is string => !!id))
  const lines = await readLines(db, rma.id)
  const sold = await soldFactsOf(db, lines)
  const check = await checkPolicy(db, { companyId: rma.companyId, partyId: rma.partyId, channel, withdrawal: false, lines: lines.map((line) => ({ invoiceLineId: line.invoiceLineId, salesOrderLineId: line.salesOrderLineId, size: line.size, seq: line.seq })), from: rma.authorisedAt ? businessDate(rma.authorisedAt) : today, now })
  const waiting = lines.length
    ? await db.approvalTask.findMany({ where: { kind: 'CREDIT_WITHOUT_RETURN', recordType: CREDIT_WITHOUT_RETURN_RECORD, recordId: { in: lines.map((line) => line.id) }, status: 'PENDING' }, select: { id: true, recordId: true, requestedAt: true, approverRoleId: true, approverUserId: true, dueAt: true } })
    : []
  const waitingOf = new Map(waiting.map((task) => [task.recordId, task]))
  const ruleIds = [...new Set(lines.flatMap((line) => (line.feeRuleId ? [line.feeRuleId] : [])))]
  const rules = ruleIds.length ? new Map((await db.returnFeeRule.findMany({ where: { id: { in: ruleIds } }, select: FEE_RULE_COLUMNS })).map((row) => [row.id, row])) : new Map<string, FeeRuleRow>()
  const receivedOn = rma.receivedAt ? businessDate(rma.receivedAt) : null
  const goodsDueBy = dayOrNull(rma.goodsDueBy)
  const open = CREDIT_WITHOUT_RETURN_STATUSES.includes(rma.status as ReturnStatus)
  return {
    id: rma.id,
    number: rma.number,
    status: rma.status,
    companyId: rma.companyId,
    siteId: rma.siteId,
    partyId: rma.partyId,
    channel,
    policy: {
      named: named ? policyView(named, used.get(named.id) ?? 0) : null,
      live: live ? policyView(live, used.get(live.id) ?? 0) : null,
      /** The return names the live policy of its channel. */
      current: named !== null && live !== null && named.id === live.id,
      withdrawal: rma.withdrawal,
      /** No policy named: the sales settings' return policy applies, and no fee rule. */
      followsSalesSettings: named === null,
      check,
    },
    deadline: { goodsDueBy, receivedOn, arrival: arrivalOf(goodsDueBy, receivedOn, today) },
    scanCode: rma.scanCode,
    papers: { printable: rma.scanCode !== null, held: rma.scanCode ? null : ['AUTHORISED', 'RECEIVED', 'INSPECTED'].includes(rma.status) ? null : `Return ${rma.number} is ${rma.status.toLowerCase()}: no papers to print.` },
    feesApply: named !== null,
    lines: lines.map((line) => {
      const facts = sold.get(lineKeyOf(line))
      const currency = currencyOf(facts)
      const value = lineValue(facts, line.quantity)
      const task = waitingOf.get(line.id)
      const problems = creditWithoutReturnProblems({ status: rma.status as ReturnStatus, seq: line.seq, quantity: line.quantity, received: line.receivedQuantity, decided: line.disposition !== null, value, waiting: task !== undefined }, undefined)
      const rule = line.feeRuleId ? rules.get(line.feeRuleId) : undefined
      const credit = (line.creditAmount ?? 0) + (line.feeAmount ?? 0)
      const fee = rule ? feeOf(feeRuleLike(rule), { credit, currency, cause: line.cause as ReturnCause | null }) : null
      const dropped = rule && line.feeAmount === 0 ? (fee?.dropped ?? null) : null
      const feeWords = rule ? (dropped && fee ? fee.words : `${rule.name}: ${feeTermsWords(feeRuleLike(rule))}`) : null
      return {
        id: line.id,
        seq: line.seq,
        size: line.size,
        quantity: line.quantity,
        receivedQuantity: line.receivedQuantity,
        serial: line.serial,
        batchNumber: line.batchNumber,
        garmentSerial: line.garmentSerial,
        garmentBatch: line.garmentBatch,
        parentLineId: line.parentLineId,
        exchangeSize: line.exchangeSize,
        window: check.lines.find((entry) => entry.seq === line.seq)?.window ?? null,
        currency,
        value: asMoney('price', value),
        creditAmount: asMoney('price', line.creditAmount),
        creditWithoutReturn: {
          credited: line.creditWithoutReturn,
          waiting: task ? { taskId: task.id, requestedAt: toUtcIso(task.requestedAt), approverRoleId: task.approverRoleId, approverUserId: task.approverUserId, dueAt: task.dueAt ? toUtcIso(task.dueAt) : null } : null,
          allowed: open && problems.length === 0,
          held: line.creditWithoutReturn ? null : (problems[0]?.message ?? null),
        },
        fee: rule && feeWords
          ? { ruleId: rule.id, ruleName: rule.name, amount: asMoney('price', line.feeAmount), dropped, words: feeWords, wordsWithAmount: asMoney('price', dropped ? feeWords : feeWithAmount({ amount: line.feeAmount ?? 0, dropped: null, words: feeWords }, currency)) }
          : null,
      }
    }),
    version: rma.version,
  }
}

export type ReturnDepth = Awaited<ReturnType<typeof depthOf>>

/** The depth of an RMA read again (after a write). */
export async function depthOfId(caller: CommandCaller, returnId: string): Promise<ReturnDepth> {
  return caller.withClient(async (client) => {
    const rma = await readRma(client, returnId)
    if (!rma) throw new NotFoundError('Return not found.')
    return depthOf(client, rma)
  })
}

/** GET /sales/returns/arrived-late */
export async function arrivedLate(caller: CommandCaller, query: { readonly companyId?: string | undefined; readonly view?: 'open' | 'all' | undefined }) {
  const context = officeOf(caller)
  const now = serverClock.now()
  const today = businessDate(now)
  if (query.companyId !== undefined && !isUuid(query.companyId)) throw new NotFoundError('Company not found.')
  return caller.withClient(async (client) => {
    const scope = scopeWhere(actorOf(context), SALES_RETURNS_VIEW, { company: 'companyId', site: 'siteId', party: 'partyId' })
    const statuses = query.view === 'all' ? ['RECEIVED', 'INSPECTED', 'CLOSED'] : ['RECEIVED', 'INSPECTED']
    // The candidates (a deadline, goods received), newest receipt first; the Rome day of the receipt decides.
    const candidates = await client.returnAuthorisation.findMany({
      where: { AND: [scope, query.companyId ? { companyId: query.companyId } : {}, { status: { in: statuses as ReturnStatus[] } }, { goodsDueBy: { not: null } }, { receivedAt: { not: null } }] },
      select: { id: true, number: true, companyId: true, siteId: true, partyId: true, status: true, goodsDueBy: true, receivedAt: true },
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      take: 2000,
    })
    const late = candidates.flatMap((row) => {
      const arrival = arrivalOf(dayOrNull(row.goodsDueBy), row.receivedAt ? businessDate(row.receivedAt) : null, today)
      return arrival.state === 'LATE' ? [{ row, arrival }] : []
    })
    const shown = late.slice(0, DEPTH_LIMITS.list)
    const parties = shown.length ? await client.party.findMany({ where: { id: { in: [...new Set(shown.map((entry) => entry.row.partyId))] } }, select: { id: true, code: true, legalName: true } }) : []
    const partyOf = new Map(parties.map((row) => [row.id, row]))
    return {
      rows: shown.map(({ row, arrival }) => ({
        id: row.id,
        number: row.number,
        companyId: row.companyId,
        siteId: row.siteId,
        party: partyOf.get(row.partyId) ?? null,
        status: row.status,
        goodsDueBy: dayOrNull(row.goodsDueBy),
        receivedOn: row.receivedAt ? businessDate(row.receivedAt) : null,
        daysLate: arrival.daysLate,
        words: arrival.words,
      })),
      count: late.length,
      truncated: late.length > shown.length || candidates.length === 2000,
      asOf: toUtcIso(now),
    }
  })
}
