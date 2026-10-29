import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { QUOTE_RULE_DEFAULTS, type QuoteRules } from '@nexus/factory-domain/sales/quotes/rules'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import type { CommandTx } from '../../../core/command'

/**
 * Where a company's quote rules come from (factory-domain sales/quotes/rules): the margin floor, the discount limit, the
 * default validity and deposit. One seam, so the rules never know where they are kept: `quoteRulesFor(client, companyId)`
 * is what the commands and reads use. By default the SalesSettings table (factory-db sales.prisma, kept by
 * ./settings.ts): the company's own row, else the tenant-wide one, else QUOTE_RULE_DEFAULTS. Tests may swap the source
 * with `useQuoteRules(source)` (and put the default back with `useQuoteRules(undefined)`).
 */
export interface QuoteRuleSource {
  rulesFor(client: FactoryClient | CommandTx, companyId: string): Promise<QuoteRules>
}

export const SALES_SETTINGS_COLUMNS = {
  id: true,
  companyId: true,
  marginFloorPct: true,
  discountLimitPct: true,
  defaultValidityDays: true,
  defaultDepositPct: true,
  version: true,
  updatedAt: true,
} as const satisfies Prisma.SalesSettingsSelect
export type SalesSettingsRow = Prisma.SalesSettingsGetPayload<{ select: typeof SALES_SETTINGS_COLUMNS }>

const text = (value: { toString(): string }): string => decimalText(value.toString())

/** A settings row as the rules (the company's or the tenant's). */
export const rulesOfRow = (row: SalesSettingsRow): QuoteRules => ({
  marginFloorPct: text(row.marginFloorPct),
  discountLimitPct: text(row.discountLimitPct),
  defaultValidityDays: row.defaultValidityDays,
  defaultDepositPct: row.defaultDepositPct === null ? null : text(row.defaultDepositPct),
  source: row.companyId === null ? 'TENANT' : 'COMPANY',
})

/** The company's row and the tenant-wide one (the tenant's rows only: row-level security). */
export const settingsRowsFor = (client: FactoryClient | CommandTx, companyId: string | null): Promise<SalesSettingsRow[]> =>
  client.salesSettings.findMany({ where: { OR: [{ companyId: null }, ...(companyId === null ? [] : [{ companyId }])] }, select: SALES_SETTINGS_COLUMNS })

/** The rules in force for a company: its own row, else the tenant-wide one, else the defaults. */
export function rulesInForce(rows: readonly SalesSettingsRow[], companyId: string | null): QuoteRules {
  const own = companyId === null ? undefined : rows.find((row) => row.companyId === companyId)
  const tenant = rows.find((row) => row.companyId === null)
  const row = own ?? tenant
  return row ? rulesOfRow(row) : QUOTE_RULE_DEFAULTS
}

export const TABLE_QUOTE_RULES: QuoteRuleSource = Object.freeze({
  rulesFor: async (client: FactoryClient | CommandTx, companyId: string) => rulesInForce(await settingsRowsFor(client, companyId), companyId),
})

/** Every company quotes by QUOTE_RULE_DEFAULTS (no table read). */
export const DEFAULT_QUOTE_RULES: QuoteRuleSource = Object.freeze({
  rulesFor: async () => QUOTE_RULE_DEFAULTS,
})

let configured: QuoteRuleSource | undefined

export function useQuoteRules(source: QuoteRuleSource | undefined): void {
  configured = source
}

export function quoteRulesFor(client: FactoryClient | CommandTx, companyId: string): Promise<QuoteRules> {
  return (configured ?? TABLE_QUOTE_RULES).rulesFor(client, companyId)
}
