import type { Issue } from '../../core/errors'
import type { ShipmentStatus, TransportBy } from '../shipments'

/**
 * The freight charged to the customer (B-W2a-48; LOG-105; SCOPE "Freight charge lines on invoices for daily orders"):
 * a site's rule (ShippingSettings.freightRule, freightAmount, freightFreeFrom, in the company's currency, minor units)
 * gives a shipment its charge (Shipment.freightCharge, the order's currency, minor units) when the goods leave; the
 * office may type another one, or clear it back to the rule, until the shipment is cancelled. The invoice charges it
 * (B-W2a-54). A price (money.price): the floor never reads it, and no figure is ever written in the words here.
 *
 *   NONE           no freight charged by default (0); the office may still type one
 *   PER_SHIPMENT   the amount once per shipment
 *   PER_PARCEL     the amount for each parcel that leaves
 *   free from      an order whose net value reaches it ships free (0); null: never free
 *
 * Before the rule: a customer who collects (transport by the recipient) or whose agreed Incoterm leaves the carriage to
 * it (EXW, FCA) is charged nothing; an order that carries no price (a replacement order from a return, B-W2a-43) is
 * charged nothing; an order in another currency than the rule's gets no charge by rule (typed by hand).
 */

export const FREIGHT_RULES = ['NONE', 'PER_SHIPMENT', 'PER_PARCEL'] as const
export type FreightRule = (typeof FREIGHT_RULES)[number]

/** The largest amount a column holds (PostgreSQL integer). */
export const MAX_FREIGHT = 2_147_483_647

/** The Incoterms 2020 rules under which the buyer pays the main carriage. */
export const BUYER_CARRIAGE_INCOTERMS: readonly string[] = Object.freeze(['EXW', 'FCA'])

export interface FreightRuleSettings {
  readonly rule: FreightRule
  /** Minor units, 0 or more; exactly with a charging rule. */
  readonly amount: number | null
  /** The order's net value (minor units) from which it ships free; null: never free. */
  readonly freeFrom: number | null
  /** The company's currency (the rule's). */
  readonly currency: string
}

export interface FreightFacts {
  /** The site's rule; null: the site has no shipping settings. */
  readonly settings: FreightRuleSettings | null
  readonly transportBy: TransportBy
  /** The customer's agreed Incoterm (Party.incoterm). */
  readonly incoterm: string | null
  readonly orderCurrency: string
  /** The order's net value, minor units. */
  readonly orderNet: number
  readonly parcels: number
}

/** Why the rule gives what it gives (for the screen's words and the audit). */
export const FREIGHT_BASES = ['NO_SETTINGS', 'CUSTOMER_COLLECTS', 'BUYER_INCOTERM', 'NO_PRICE', 'OTHER_CURRENCY', 'RULE_NONE', 'FREE_FROM', 'PER_SHIPMENT', 'PER_PARCEL', 'NO_PARCELS'] as const
export type FreightBasis = (typeof FREIGHT_BASES)[number]

export interface FreightByRule {
  /** Minor units in the order's currency; null: the rule gives none (type it by hand). */
  readonly charge: number | null
  readonly basis: FreightBasis
  /** In words, without any figure (the words reach every reader of the shipment). */
  readonly words: string
}

const result = (charge: number | null, basis: FreightBasis, words: string): FreightByRule => ({ charge, basis, words })

/** What the site's rule charges for this shipment (see the file's comment). */
export function freightByRule(facts: FreightFacts): FreightByRule {
  if (facts.transportBy === 'RECIPIENT') return result(0, 'CUSTOMER_COLLECTS', 'The customer collects the goods: no freight is charged.')
  const incoterm = facts.incoterm?.trim().toUpperCase() ?? ''
  if (BUYER_CARRIAGE_INCOTERMS.includes(incoterm)) return result(0, 'BUYER_INCOTERM', `The customer's terms are ${incoterm}: it pays the carriage, so no freight is charged.`)
  if (facts.orderNet <= 0) return result(0, 'NO_PRICE', 'Nothing on the order carries a price (a replacement order): no freight is charged.')
  const settings = facts.settings
  if (!settings) return result(null, 'NO_SETTINGS', 'The site has no shipping settings, so no freight rule: type the freight charged by hand.')
  if (settings.rule === 'NONE') return result(0, 'RULE_NONE', 'The site charges no freight by default.')
  if (settings.currency !== facts.orderCurrency) {
    return result(null, 'OTHER_CURRENCY', `The order is in ${facts.orderCurrency} and the site's freight rule in ${settings.currency}: type the freight charged by hand.`)
  }
  if (settings.freeFrom !== null && facts.orderNet >= settings.freeFrom) return result(0, 'FREE_FROM', "The order's net value reaches the site's free-freight value: the freight is free.")
  const amount = settings.amount ?? 0
  if (settings.rule === 'PER_SHIPMENT') return result(amount, 'PER_SHIPMENT', "The site's rule charges one amount per shipment.")
  if (facts.parcels <= 0) return result(null, 'NO_PARCELS', "The site's rule charges per parcel and the shipment has no parcel yet.")
  const charge = amount * facts.parcels
  if (!Number.isSafeInteger(charge) || charge > MAX_FREIGHT) return result(null, 'PER_PARCEL', "The site's rule charges per parcel, and the total is too large: type the freight charged by hand.")
  return result(charge, 'PER_PARCEL', `The site's rule charges one amount for each of the ${facts.parcels} parcel${facts.parcels === 1 ? '' : 's'}.`)
}

const isAmount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_FREIGHT

/** A site's freight rule as sent (the database's ShippingSettings_freight_guard holds the same). */
export function freightRuleProblems(input: { readonly rule: FreightRule; readonly amount?: number | null | undefined; readonly freeFrom?: number | null | undefined }, at = 'body'): Issue[] {
  const problems: Issue[] = []
  const amount = input.amount ?? null
  const freeFrom = input.freeFrom ?? null
  if (input.rule === 'NONE') {
    if (amount !== null) problems.push({ path: `${at}/amount`, message: 'A site that charges no freight has no amount: leave it out, or choose a rule.' })
    if (freeFrom !== null) problems.push({ path: `${at}/freeFrom`, message: 'A site that charges no freight has no free-freight value.' })
    return problems
  }
  if (amount === null) problems.push({ path: `${at}/amount`, message: 'Give the amount the rule charges (minor units, 0 or more).' })
  else if (!isAmount(amount)) problems.push({ path: `${at}/amount`, message: 'Expected whole minor units, 0 or more.' })
  if (freeFrom !== null && !isAmount(freeFrom)) problems.push({ path: `${at}/freeFrom`, message: 'Expected whole minor units, 0 or more.' })
  return problems
}

/** Why the office cannot change a shipment's freight charge now (empty: it can): until the shipment is cancelled. */
export function freightChargeProblems(status: ShipmentStatus, charge: number | null): string[] {
  if (status === 'CANCELLED') return ['The shipment is CANCELLED: its freight charge no longer changes.']
  if (charge !== null && !isAmount(charge)) return ['Expected the freight charged as whole minor units, 0 or more.']
  return []
}
