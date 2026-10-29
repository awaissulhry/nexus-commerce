import type { FactoryClient } from '@nexus/factory-db'
import { QUOTE_RULE_DEFAULTS, type QuoteRules } from '@nexus/factory-domain/sales/quotes/rules'
import type { CommandTx } from '../../../core/command'

/**
 * Where a company's quote rules come from (factory-domain sales/quotes/rules): the margin floor, the discount limit, the
 * default validity and deposit. One seam, so the rules never know where they are kept: `quoteRulesFor(client, companyId)`
 * is what the commands and reads use; by default every company quotes by QUOTE_RULE_DEFAULTS. The Sales settings table
 * (B-W1-21's follow-up: the company's row, else the tenant's, as CostingSettings) becomes the default source here.
 * Tests may swap it with `useQuoteRules(source)` (and put the default back with `useQuoteRules(undefined)`).
 */
export interface QuoteRuleSource {
  rulesFor(client: FactoryClient | CommandTx, companyId: string): Promise<QuoteRules>
}

export const DEFAULT_QUOTE_RULES: QuoteRuleSource = Object.freeze({
  rulesFor: async () => QUOTE_RULE_DEFAULTS,
})

let configured: QuoteRuleSource | undefined

export function useQuoteRules(source: QuoteRuleSource | undefined): void {
  configured = source
}

export function quoteRulesFor(client: FactoryClient | CommandTx, companyId: string): Promise<QuoteRules> {
  return (configured ?? DEFAULT_QUOTE_RULES).rulesFor(client, companyId)
}
