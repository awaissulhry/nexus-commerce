import { ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { SALES_RETURNS_DECIDE } from '@nexus/factory-domain/sales/returns/permissions'
import { feeOf, feeWithAmount, pickFeeRule, type FeeDrop, type PolicyChannel } from '@nexus/factory-domain/sales/returns-depth/rules'
import { defaultCredit, type ReturnCause, type ReturnDisposition } from '@nexus/factory-domain/sales/returns/rules'
import type { CommandCaller } from '../../../core/command'
import { officeReturn } from '../returns/access'
import { currencyOf, lineKeyOf, lineValue, readLines, soldFactsOf, type Reader, type RmaRow } from '../returns/store'
import { feeRuleLike, readFeeRules } from './store'

/**
 * Restocking and handling fees on a decision (B-W2b-341; SAL-343; design rma.credit "Restocking or handling fee (W2b,
 * dropped when the cause is ours)"). Only on a return checked against a return policy (./policy-check.ts: the policy names
 * the channel the rules key on; a return made before W2b-5, or never checked, has no fee, as W2a). For each decided line
 * with a credit: the first active rule of the RMA's company (factory-domain pickFeeRule) gives its fee (feeOf), withheld
 * from the credit; dropped when the cause found is ours; no credit, no fee. The decision (modules/sales/returns/decide.ts,
 * B-W2a-43's, which calls `decisionFees` for its preview and its command) writes the credit after the fee, the fee and its
 * rule on the line, in the same command; the credit note credits what is left.
 *
 *   POST /sales/returns/:returnId/fees/preview  (sales.returns.decide, the price grain) what the rules would withhold from
 *                                               the credits a decision names (as the decision's own preview reads them)
 */

export interface DecisionFeeLine {
  readonly lineId: string
  readonly reasonCode: string
  readonly cause: ReturnCause | null
  /** The credit decided before the fee (minor units). */
  readonly credit: number
  readonly currency: string | null
}

export interface DecisionFee {
  readonly ruleId: string
  readonly ruleName: string
  /** Withheld (minor units; 0 when dropped). */
  readonly amount: number
  readonly dropped: FeeDrop | null
  readonly creditAfter: number
  readonly words: string
}

/** The policy's channel (null: the RMA names no policy, so no fee rule applies). */
export async function channelOfReturn(db: Reader, rma: Pick<RmaRow, 'policyId'>): Promise<PolicyChannel | null> {
  if (!rma.policyId) return null
  const policy = await db.returnPolicy.findUnique({ where: { id: rma.policyId }, select: { channel: true } })
  return (policy?.channel as PolicyChannel | undefined) ?? null
}

/**
 * The fee of each line with a credit (lines without a matching rule, or without a credit, are left out). Read in the
 * decision's own transaction, so the rule it names is the active one the guard checks.
 */
export async function decisionFees(db: Reader, rma: Pick<RmaRow, 'companyId' | 'policyId'>, lines: readonly DecisionFeeLine[]): Promise<Map<string, DecisionFee>> {
  const out = new Map<string, DecisionFee>()
  const channel = await channelOfReturn(db, rma)
  if (channel === null || lines.length === 0) return out
  const rules = (await readFeeRules(db, { companyId: rma.companyId, active: true })).map(feeRuleLike)
  for (const line of lines) {
    if (line.credit <= 0) continue
    const rule = pickFeeRule(rules, { channel, reasonCode: line.reasonCode })
    if (!rule) continue
    const fee = feeOf(rule, { credit: line.credit, currency: line.currency, cause: line.cause })
    // A fixed fee in another currency gives nothing: the rule is not named on the line.
    if (fee.dropped === 'OTHER_CURRENCY') continue
    out.set(line.lineId, { ruleId: rule.id, ruleName: rule.name, amount: fee.amount, dropped: fee.dropped, creditAfter: fee.creditAfter, words: fee.words })
  }
  return out
}

export interface FeePreviewBody {
  readonly lines: readonly { readonly lineId: string; readonly disposition: ReturnDisposition; readonly creditAmount?: number | null | undefined }[]
}

/** POST /sales/returns/:returnId/fees/preview: per line the rule, the fee, the credit before and after it. Writes nothing. */
export async function previewFees(caller: CommandCaller, returnId: string, body: FeePreviewBody) {
  const { rma } = await officeReturn(caller, returnId, SALES_RETURNS_DECIDE)
  return caller.withClient(async (client) => {
    const lines = await readLines(client, rma.id)
    const byId = new Map(lines.map((line) => [line.id, line]))
    const sold = await soldFactsOf(client, lines)
    const problems: Issue[] = []
    const asked = body.lines.flatMap((entry, index) => {
      const line = byId.get(entry.lineId)
      if (!line) {
        problems.push({ path: `body/lines/${index}/lineId`, message: 'Not a line of this return.' })
        return []
      }
      const facts = sold.get(lineKeyOf(line))
      const value = lineValue(facts, line.receivedQuantity)
      const credit = entry.creditAmount ?? defaultCredit(entry.disposition, value)
      return [{ line, credit, currency: currencyOf(facts) }]
    })
    if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'Some lines are not of this return.', problems)
    const channel = await channelOfReturn(client, rma)
    const fees = await decisionFees(client, rma, asked.map((entry) => ({ lineId: entry.line.id, reasonCode: entry.line.reasonCode, cause: entry.line.cause as ReturnCause | null, credit: entry.credit, currency: entry.currency })))
    return {
      policyNamed: rma.policyId !== null,
      channel,
      /** Why no fee can apply, in words (null: the rules apply). */
      noFees: rma.policyId === null ? 'This return was not checked against a return policy: no fee rule applies (check it against the policy first).' : null,
      lines: asked.map((entry) => {
        const fee = fees.get(entry.line.id) ?? null
        return {
          lineId: entry.line.id,
          seq: entry.line.seq,
          currency: entry.currency,
          creditBefore: asMoney('price', entry.credit),
          fee: fee ? { ruleId: fee.ruleId, ruleName: fee.ruleName, amount: asMoney('price', fee.amount), dropped: fee.dropped, words: fee.words, wordsWithAmount: asMoney('price', feeWithAmount(fee, entry.currency)) } : null,
          creditAfter: asMoney('price', fee ? fee.creditAfter : entry.credit),
        }
      }),
    }
  })
}
