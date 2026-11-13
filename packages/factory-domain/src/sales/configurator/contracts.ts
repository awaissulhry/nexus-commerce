import { z } from 'zod'
import { id, input, instant, output } from '../../core/contracts'
import { money, notMoney } from '../../money/marked'
import { CHECK_CODES, OPTION_GROUP_KINDS, OPTION_LIMITS, OPTION_RULE_KINDS, OPTION_RULE_SEVERITIES } from '../../product/options/rules'
import { MASTER_STATUSES } from '../../product/sizes/rules'
import { CONFIGURATOR_LIMITS, REPRICE_HELD } from './rules'

/**
 * The configurator's shapes (B-W2b-340; SAL-133, SAL-136, SAL-139, SAL-140, SAL-249): what apps/factory-api's
 * modules/sales/configurator accepts and answers. Money (A1 §3.11): a value's surcharge, a frozen surcharge, a line's prices
 * and the waterfall are the price grain (money.price), the line's unit cost the cost grain, its margin the margin grain:
 * dropped from the answer of a caller without the grain, refused in a request that sends one. Decimals are plain strings.
 */

const words = () => output({ it: z.string(), en: z.string() })
const names = () => z.record(z.string(), z.string()).nullable()

/** One value chosen on a line: its typed text, and a library colour OR a material and its colour. */
export const linePickBody = input({
  valueId: id(),
  text: z.string().max(OPTION_LIMITS.freeTextLength * 2).nullish(),
  colourId: id().nullish(),
  itemId: id().nullish(),
  itemColourId: id().nullish(),
})
export const picksBody = () => z.array(linePickBody).max(CONFIGURATOR_LIMITS.picks)

export const quoteLineParams = input({ quoteId: id(), lineId: id() })
export const orderLineParams = input({ orderId: id(), lineId: id() })
export const styleParams = input({ styleId: id() })

/** A value's surcharge as the library keeps it: an amount in a currency, or a percent (never both shown as one). */
const surcharge = () => money.price(output({ delta: z.string().nullable(), currency: z.string().nullable(), percent: z.string().nullable() }).nullable())

const valueView = output({
  id: id(),
  code: z.string(),
  name: z.string(),
  nameI18n: names(),
  /** An archived value is shown (a line that chose it still names it), never offered. */
  status: z.enum(MASTER_STATUSES),
  freeText: z.boolean(),
  freeTextMaxLength: z.number().int().nullable(),
  freeTextPattern: z.string().nullable(),
  /** A CERTIFICATE effect: the garment leaves its certificate with this value (its note: what is no longer covered). */
  outsideCertificate: z.boolean(),
  certificateNote: z.string().nullable(),
  surcharge: surcharge(),
})

const ruleView = output({
  ruleId: id(),
  /** The subject (null: any value of the group). */
  valueId: id().nullable(),
  kind: z.enum(OPTION_RULE_KINDS),
  otherValueId: id(),
  severity: z.enum(OPTION_RULE_SEVERITIES),
  /** The preview ("Full perforation excludes Thermal liner"). */
  words: words(),
  /** What the person reads when it is broken (its message, else the API's words). */
  broken: words(),
})

const groupView = output({
  groupId: id(),
  code: z.string(),
  name: z.string(),
  nameI18n: names(),
  kind: z.enum(OPTION_GROUP_KINDS),
  minPicks: z.number().int(),
  maxPicks: z.number().int().nullable(),
  picks: words(),
  defaultValueId: id().nullable(),
  values: z.array(valueView),
  rules: z.array(ruleView),
})

const colourChoice = output({ id: id(), code: z.string(), name: z.string(), nameI18n: names(), hex: z.string().nullable() })
const leatherChoice = output({ id: id(), code: z.string(), name: z.string(), colours: z.array(output({ id: id(), code: z.string(), name: z.string(), hex: z.string().nullable() })) })

/** A style's configurator: its offered groups, values with their surcharges and rules, the panel colours and leathers. */
export const configuratorStyleView = output({
  style: output({ id: id(), code: z.string(), name: z.string(), companyId: id().nullable(), status: z.string() }),
  colourway: output({ id: id(), code: z.string(), name: z.string() }).nullable(),
  /** The chosen colourway's picture (its first), else the style's main picture; through GET /product/pictures/:fileId. */
  picture: output({ fileId: id(), name: z.string(), contentType: z.string(), source: z.enum(['COLOURWAY', 'STYLE']) }).nullable(),
  groups: z.array(groupView),
  choices: output({ colours: z.array(colourChoice), leathers: z.array(leatherChoice) }),
})
export type ConfiguratorStyleView = z.infer<typeof configuratorStyleView>

const finding = output({ code: z.enum(CHECK_CODES), severity: z.enum(OPTION_RULE_SEVERITIES), path: z.string(), groupId: id().nullable(), valueId: id().nullable(), ruleId: id().nullable(), message: words() })

const checkPart = {
  ok: z.boolean(),
  blocks: z.array(finding),
  warnings: z.array(finding),
  outsideCertificate: z.boolean(),
  certificateNotes: z.array(output({ valueId: id(), note: z.string() })),
}

const chosenView = output({
  /** The option row (null in a preview). */
  id: id().nullable(),
  groupId: id(),
  valueId: id(),
  text: z.string().nullable(),
  byDefault: z.boolean(),
  colourId: id().nullable(),
  itemId: id().nullable(),
  itemColourId: id().nullable(),
  surchargeAmount: money.price(z.string().nullable()),
  surchargePct: money.price(z.string().nullable()),
})

const artworkView = output({
  fileId: id(),
  name: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int(),
  status: z.string(),
  createdAt: instant(),
  /** LINE: this line's; QUOTE_LINE: the quote line the order line was made from. */
  from: z.enum(['LINE', 'QUOTE_LINE']),
})

/** A quote or order line's configurator. */
export const lineConfiguratorView = output({
  document: output({
    kind: z.enum(['QUOTE', 'ORDER']),
    id: id(),
    number: z.string(),
    /** The quote's or the order's version (a write sends it). */
    version: z.number().int(),
    status: z.string(),
    revision: z.number().int().nullable(),
    currency: z.string(),
    priceBasis: notMoney(z.enum(['NET', 'GROSS'])),
  }),
  line: output({
    id: id(),
    seq: z.number().int(),
    kind: z.string(),
    quantity: z.number().int(),
    unitPrice: money.price(z.string()),
    listUnitPrice: money.price(z.string().nullable()),
    unitCost: money.cost(z.string().nullable()),
    marginPct: money.margin(z.string().nullable()),
    optionsTotal: money.price(z.string()),
  }),
  ...configuratorStyleView.shape,
  chosen: z.array(chosenView),
  check: output(checkPart),
  /** Whether the line's waterfall holds the options' surcharges; why a quote line is not priced again; a manual change kept. */
  pricing: output({ holdsOptions: z.boolean(), held: z.enum(REPRICE_HELD).nullable(), manualKept: z.boolean() }),
  artwork: z.array(artworkView),
  /** configure: the person may change the options now (else `held` says why); artwork: may add files. */
  may: output({ configure: z.boolean(), held: words().nullable(), artwork: z.boolean() }),
})
export type LineConfiguratorView = z.infer<typeof lineConfiguratorView>

export const checkLineBody = input({ picks: picksBody() })
export type CheckLineBody = z.output<typeof checkLineBody>

/** A choice checked without writing: the check, the surcharges it would freeze, the price it would make. */
export const checkLineView = output({
  ...checkPart,
  chosen: z.array(chosenView),
  pricing: output({
    /** A quote line priced again with these options (else `held`); an order keeps its accepted price. */
    repriced: notMoney(z.boolean()),
    held: z.enum(REPRICE_HELD).nullable(),
    manualKept: z.boolean(),
    unitPrice: money.price(z.string()),
    before: money.price(z.string()),
    optionsTotal: money.price(z.string()),
    /** On an order: what the options would add a piece more (or less) than accepted. */
    change: money.price(z.string().nullable()),
    steps: money.price(z.array(z.record(z.string(), z.unknown())).nullable()),
    marginPct: money.margin(z.string().nullable()),
    marginBefore: money.margin(z.string().nullable()),
  }),
  /** A surcharge in another currency, said in words (the choice cannot be priced). */
  problem: words().nullable(),
})
export type CheckLineView = z.infer<typeof checkLineView>

export const saveQuoteOptionsBody = input({ version: z.number().int().min(1), picks: picksBody() })
export type SaveQuoteOptionsBody = z.output<typeof saveQuoteOptionsBody>

export const saveOrderOptionsBody = input({
  version: z.number().int().min(1),
  picks: picksBody(),
  /** The options add more (or less) than accepted: keep the accepted price (the change given). */
  keepPrice: notMoney(z.boolean().optional()),
})
export type SaveOrderOptionsBody = z.output<typeof saveOrderOptionsBody>

export const artworkBody = input({
  originalName: z.string().min(1).max(500),
  /** application/pdf, image/jpeg, image/png or image/webp. */
  contentType: z.string().min(1).max(200),
  sizeBytes: z.number().int().min(1),
  sha256: z.string(),
})
export type ArtworkBody = z.output<typeof artworkBody>
