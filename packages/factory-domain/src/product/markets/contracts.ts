import { z } from 'zod'
import { id, input, output } from '../../core/contracts'
import { MARKET_CODE_MAX } from '../../compliance/markets/rules'
import { MARKET_STANDINGS, STYLE_MARKETS_MAX } from './rules'

/**
 * The contracts of the markets a style is sold in (B-W2b-283, FU1:01; ./rules.ts): what apps/factory-api's
 * modules/product/markets accepts and answers. Codes, names, languages and switches of the market profiles; no money, no
 * person.
 */

export const styleMarketsParams = input({ styleId: id() })

/** The whole list at the style's version ([] = every market); the reason goes to the audit row. */
export const setStyleMarketsBody = input({
  version: z.number().int().min(1),
  marketCodes: z.array(z.string().trim().min(1).max(MARKET_CODE_MAX)).max(STYLE_MARKETS_MAX),
  reason: z.string().trim().min(1).max(500).optional(),
})
export type SetStyleMarketsBody = z.output<typeof setStyleMarketsBody>

export const marketChoiceView = output({
  code: z.string(),
  name: z.string(),
  /** The name per language (BCP 47 → words); {}: `name` only. */
  nameI18n: z.record(z.string(), z.string()),
  /** null: every company's market. */
  companyId: id().nullable(),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  /** OFF: the market's own rules wait (Compliance › Rules & markets). */
  switchedOn: z.boolean(),
  /** The languages the gate asks there once the style is sold there (DoC, user information, label). */
  docLanguages: z.array(z.string()),
  userInfoLanguages: z.array(z.string()),
  labelLanguages: z.array(z.string()),
  /** The style names it. */
  picked: z.boolean(),
  /** It may be added now (active, of the style's company or every company). */
  offered: z.boolean(),
})
export type MarketChoiceView = z.infer<typeof marketChoiceView>

export const styleMarketsView = output({
  style: output({ id: id(), code: z.string(), name: z.string(), companyId: id().nullable(), version: z.number().int(), status: z.string() }),
  /** In the markets' order ([] = every market). */
  marketCodes: z.array(z.string()),
  /** EVERY_MARKET (none picked) or SOLD_THERE (a list). */
  standing: z.enum(MARKET_STANDINGS),
  /** The markets the pick offers and every one the style names (an archived or another company's one too). */
  markets: z.array(marketChoiceView),
  /** product.styles.manage over the style's company. */
  mayChange: z.boolean(),
  /** Why the list does not change now (archived style, its edit rule), in words; null: it may. */
  refusal: output({ code: z.string(), message: z.string() }).nullable(),
})
export type StyleMarketsView = z.infer<typeof styleMarketsView>
