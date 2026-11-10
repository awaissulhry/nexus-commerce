import type { ExpectedSender } from '@nexus/factory-domain/compliance/label-rules/marking'
import { labelMarking, labelRuleChecks, type LabelMarking, type LabelRuleCheck, type RuleMarket } from '@nexus/factory-domain/compliance/label-rules/rules'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { TEMPLATE_SELECT, type Reader, type TemplateRow } from '../labels/store'
import { MARKET_SELECT, readRuleFacts, RULE_STYLE_SELECT, ruleMarketOf, senderFor, type MarketRow, type RuleStyleRow, type RuleWorkOrder } from './facts'

/**
 * The label's marking checks for one or more markets (B-W2b-253), and the gate's entry: B-W2b-254's label-print gate calls
 * `labelRulesFor(client, question)` inside its own command, with the command's client (office or floor), and reads the
 * check whose `gateKey` is the requirement's checkKey (`label.ceMarking`, `label.classWarnings`, `label.gloveMarking`,
 * `gpsr.contact`, `label.qrCode`): `blocks` true = refuse, `words` = the refusal's words. No permission is checked here.
 */

export interface MarketChecks {
  readonly market: RuleMarket | null
  readonly sender: ExpectedSender
  readonly checks: LabelRuleCheck[]
  /** Some check stops the label from printing for this market. */
  readonly blocks: boolean
}

export interface Evaluated {
  readonly markets: MarketChecks[]
  /** What the label must print beyond W1's fields, in the label's and the markets' languages. */
  readonly marking: LabelMarking
}

export interface EvaluateQuestion {
  readonly template: TemplateRow
  readonly style: RuleStyleRow
  readonly revisionId: string | null
  readonly colourwayId?: string | null | undefined
  readonly size?: string | null | undefined
  readonly workOrder: RuleWorkOrder | null
  /** The markets to check; empty: the label alone (its own languages, no market's markings). */
  readonly markets: readonly MarketRow[]
  readonly day: BusinessDate
  readonly office: boolean
}

export async function evaluateLabel(db: Reader, question: EvaluateQuestion): Promise<Evaluated> {
  const markets = question.markets.map(ruleMarketOf)
  const languages = [...new Set([...question.template.languages, ...markets.flatMap((market) => market.labelLanguages)])]
  const facts = await readRuleFacts(db, { ...question, languages })
  const out: MarketChecks[] = []
  for (const market of markets.length === 0 ? [null] : markets) {
    const sender = await senderFor(db, question.style, market?.code ?? null, question.day, question.workOrder?.companyId ?? null)
    const checks = labelRuleChecks(facts, market, sender)
    out.push({ market, sender, checks, blocks: checks.some((check) => check.blocks) })
  }
  // The marking in every language the label and the markets print, with the label's own GPSR sender (a market's is in its entry).
  const every: RuleMarket = { code: '*', name: '', switchedOn: true, labelLanguages: languages, markings: [], gpsrContactNeeded: false }
  const sender = markets.length === 0 ? out[0]!.sender : await senderFor(db, question.style, null, question.day, question.workOrder?.companyId ?? null)
  return { markets: out, marking: labelMarking(facts, every, sender) }
}

// ---- for B-W2b-254's gate at label print -------------------------------------------------------------------------------------------

export interface LabelRulesQuestion {
  readonly labelTemplateId: string
  readonly styleId: string
  /** The style revision the work order froze (its protector placement). */
  readonly styleRevisionId: string | null
  /** The cell printed (its certificate's class and levels); left out: the style's first active colourway in its base size. */
  readonly colourwayId?: string | null | undefined
  readonly size?: string | null | undefined
  /** The work order whose batch the QR names. */
  readonly workOrderId?: string | null | undefined
  /** The market the goods are for (MarketProfile.code); null: the label alone. */
  readonly marketCode: string | null
  readonly day: BusinessDate
  /** False on the floor: the notified body directory and the style's published declaration are not read. */
  readonly office: boolean
}

export interface LabelRulesAnswer {
  readonly checks: LabelRuleCheck[]
  /** By the requirement's checkKey. */
  readonly byCheckKey: ReadonlyMap<string, LabelRuleCheck>
  readonly blocks: boolean
}

/** The checks of a label for a market, read with the caller's client inside its own command. */
export async function labelRulesFor(db: Reader, question: LabelRulesQuestion): Promise<LabelRulesAnswer> {
  const template = await db.labelTemplate.findUnique({ where: { id: question.labelTemplateId }, select: TEMPLATE_SELECT })
  if (!template) throw new NotFoundError('Label not found.')
  const style = await db.style.findUnique({ where: { id: question.styleId }, select: RULE_STYLE_SELECT })
  if (!style) throw new NotFoundError('Style not found.')
  const order = question.workOrderId ? await db.workOrder.findUnique({ where: { id: question.workOrderId }, select: { id: true, number: true, companyId: true, batchNumber: true, releasedAt: true } }) : null
  const market = question.marketCode ? await db.marketProfile.findFirst({ where: { code: question.marketCode }, select: MARKET_SELECT }) : null
  if (question.marketCode && !market) throw new NotFoundError(`There is no market ${question.marketCode}.`)
  const evaluated = await evaluateLabel(db, {
    template,
    style,
    revisionId: question.styleRevisionId,
    colourwayId: question.colourwayId,
    size: question.size,
    workOrder: order ? { id: order.id, reference: order.number, released: order.batchNumber !== null && order.releasedAt !== null, companyId: order.companyId } : null,
    markets: market ? [market] : [],
    day: question.day,
    office: question.office,
  })
  const { checks, blocks } = evaluated.markets[0]!
  return { checks, byCheckKey: new Map(checks.map((check) => [check.gateKey, check])), blocks }
}
