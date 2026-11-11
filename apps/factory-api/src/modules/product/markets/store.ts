import type { FactoryClient, Prisma } from '@nexus/factory-db'
import type { GateTarget } from '@nexus/factory-domain/compliance/gates/gate'
import { sellsThere, type MarketChoice } from '@nexus/factory-domain/product/markets/rules'
import type { CommandTx } from '../../../core/command'

/**
 * The markets a style is sold in, as the readers need them (B-W2b-283, FU1:01; factory-domain product/markets): the style's
 * list (Style.marketCodes) and the tenant's market profiles. `soldThereTargets` is the requirements gate's one line
 * (modules/compliance/gates/gate.ts `decideGate`, marked B-W2b-283): a target going to a market the style names checks that
 * market's languages; an empty list keeps the gate's answer as it was.
 */

type Reader = FactoryClient | CommandTx

/** The style's markets ([] = every market; an unknown style: []). */
export async function styleMarketCodes(db: Pick<Reader, 'style'>, styleId: string): Promise<string[]> {
  const row = await db.style.findUnique({ where: { id: styleId }, select: { marketCodes: true } })
  return row ? [...row.marketCodes] : []
}

/** The gate's targets with `sellsThere` from the style's list (a target already set to sell there stays so: the board's). */
export function soldThereTargets<Target extends GateTarget>(targets: readonly Target[], marketCodes: readonly string[]): Target[] {
  if (marketCodes.length === 0) return [...targets]
  return targets.map((target) => (target.sellsThere || !sellsThere(marketCodes, target.market?.code ?? null) ? target : { ...target, sellsThere: true }))
}

export const MARKET_CHOICE_SELECT = {
  code: true,
  name: true,
  nameI18n: true,
  companyId: true,
  status: true,
  switchedOn: true,
  docLanguages: true,
  userInfoLanguages: true,
  labelLanguages: true,
  seq: true,
} as const satisfies Prisma.MarketProfileSelect
export type MarketChoiceRow = Prisma.MarketProfileGetPayload<{ select: typeof MARKET_CHOICE_SELECT }>

/** Every market profile of the tenant, in the status board's column order (seq, then code). */
export function marketRows(db: Pick<Reader, 'marketProfile'>): Promise<MarketChoiceRow[]> {
  return db.marketProfile.findMany({ select: MARKET_CHOICE_SELECT, orderBy: [{ seq: 'asc' }, { code: 'asc' }] })
}

export const choiceOf = (row: MarketChoiceRow): MarketChoice => ({ code: row.code, name: row.name, companyId: row.companyId, status: row.status === 'ARCHIVED' ? 'ARCHIVED' : 'ACTIVE', switchedOn: row.switchedOn })
