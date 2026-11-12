import type { Prisma } from '@nexus/factory-db'
import { toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { feeTermsWords, type FeeKind, type PolicyChannel } from '@nexus/factory-domain/sales/returns-depth/rules'
import type { FreightPayer } from '@nexus/factory-domain/sales/returns/rules'
import { dayOrNull, type Reader } from '../returns/store'

/**
 * Returns in depth's reads (B-W2b-341; factory-db service.prisma ReturnPolicy, ReturnFeeRule; returns.prisma's W2b-5
 * columns). Every read names its columns and selects no relation (inside a command's transaction Prisma would send
 * relation reads together on its one connection); a reader takes the command's transaction or a scoped client, and
 * row-level security decides what it finds.
 */

export const POLICY_RECORD = 'ReturnPolicy'
export const FEE_RULE_RECORD = 'ReturnFeeRule'

export const POLICY_COLUMNS = {
  id: true,
  companyId: true,
  channel: true,
  name: true,
  windowDays: true,
  goodsDueDays: true,
  freightPaidBy: true,
  conditions: true,
  withdrawalWords: true,
  effectiveFrom: true,
  retiredAt: true,
  retiredById: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
  updatedById: true,
} as const satisfies Prisma.ReturnPolicySelect
export type PolicyRow = Prisma.ReturnPolicyGetPayload<{ select: typeof POLICY_COLUMNS }>

export const FEE_RULE_COLUMNS = {
  id: true,
  companyId: true,
  channel: true,
  name: true,
  reasonCodes: true,
  kind: true,
  percent: true,
  amount: true,
  currency: true,
  sequence: true,
  active: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
  updatedById: true,
} as const satisfies Prisma.ReturnFeeRuleSelect
export type FeeRuleRow = Prisma.ReturnFeeRuleGetPayload<{ select: typeof FEE_RULE_COLUMNS }>

/** A decimal column as plain text ("10" for 10.0000). */
export const decimalText = (value: { toString(): string } | null): string | null => (value === null ? null : value.toString().replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''))

/** The policies a reader sees (of one company, or of every company), live first, then the newest. */
export async function readPolicies(db: Reader, where: Prisma.ReturnPolicyWhereInput): Promise<PolicyRow[]> {
  return db.returnPolicy.findMany({ where, select: POLICY_COLUMNS, orderBy: [{ companyId: 'asc' }, { channel: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }] })
}

/** The live policy of a company for a channel (one at most: the partial unique index). */
export async function livePolicyOf(db: Reader, companyId: string, channel: PolicyChannel): Promise<PolicyRow | null> {
  return db.returnPolicy.findFirst({ where: { companyId, channel, retiredAt: null }, select: POLICY_COLUMNS })
}

/** How many RMAs name each policy (one an RMA names keeps its terms). */
export async function policyUse(db: Reader, policyIds: readonly string[]): Promise<Map<string, number>> {
  if (policyIds.length === 0) return new Map()
  const rows = await db.returnAuthorisation.groupBy({ by: ['policyId'], where: { policyId: { in: [...policyIds] } }, _count: { _all: true } })
  return new Map(rows.flatMap((row) => (row.policyId ? [[row.policyId, row._count._all] as const] : [])))
}

export function policyView(row: PolicyRow, used: number) {
  return {
    id: row.id,
    companyId: row.companyId,
    channel: row.channel as PolicyChannel,
    name: row.name,
    windowDays: row.windowDays,
    goodsDueDays: row.goodsDueDays,
    freightPaidBy: row.freightPaidBy as FreightPayer,
    conditions: row.conditions,
    withdrawalWords: row.withdrawalWords,
    effectiveFrom: dayOrNull(row.effectiveFrom) as BusinessDate,
    live: row.retiredAt === null,
    retiredAt: row.retiredAt ? toUtcIso(row.retiredAt) : null,
    retiredById: row.retiredById,
    /** RMAs checked against it: its terms never change (a change is a new policy). */
    usedBy: used,
    version: row.version,
    updatedAt: toUtcIso(row.updatedAt),
    updatedById: row.updatedById ?? row.createdById,
  }
}
export type PolicyView = ReturnType<typeof policyView>

/** The fee rules of a company (or of every company the reader sees), in their order. */
export async function readFeeRules(db: Reader, where: Prisma.ReturnFeeRuleWhereInput): Promise<FeeRuleRow[]> {
  return db.returnFeeRule.findMany({ where, select: FEE_RULE_COLUMNS, orderBy: [{ companyId: 'asc' }, { sequence: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] })
}

/** How many return lines name each rule (one a line names keeps its terms). */
export async function feeRuleUse(db: Reader, ruleIds: readonly string[]): Promise<Map<string, number>> {
  if (ruleIds.length === 0) return new Map()
  const rows = await db.returnLine.groupBy({ by: ['feeRuleId'], where: { feeRuleId: { in: [...ruleIds] } }, _count: { _all: true } })
  return new Map(rows.flatMap((row) => (row.feeRuleId ? [[row.feeRuleId, row._count._all] as const] : [])))
}

/** A rule as the domain's fee functions read it. */
export const feeRuleLike = (row: FeeRuleRow) => ({
  id: row.id,
  name: row.name,
  channel: row.channel as PolicyChannel | null,
  reasonCodes: row.reasonCodes,
  kind: row.kind as FeeKind,
  percent: decimalText(row.percent),
  amount: row.amount,
  currency: row.currency,
  sequence: row.sequence,
  active: row.active,
  createdAt: toUtcIso(row.createdAt),
})

export function feeRuleView(row: FeeRuleRow, used: number, reasons: ReadonlyMap<string, { readonly labelIt: string; readonly labelEn: string; readonly active: boolean }>) {
  const like = feeRuleLike(row)
  return {
    id: row.id,
    companyId: row.companyId,
    channel: like.channel,
    name: row.name,
    reasonCodes: [...row.reasonCodes],
    reasons: row.reasonCodes.map((code) => ({ code, labelIt: reasons.get(code)?.labelIt ?? code, labelEn: reasons.get(code)?.labelEn ?? code, active: reasons.get(code)?.active ?? false })),
    kind: like.kind,
    percent: like.percent,
    /** AMOUNT: minor units of `currency` (price grain). */
    amount: asMoney('price', row.amount),
    currency: row.currency,
    /** The terms in words, without an amount ("10 % of the credit"). */
    terms: feeTermsWords(like),
    sequence: row.sequence,
    active: row.active,
    /** Return lines whose fee it gave: its terms never change (switch it off and make another). */
    usedBy: used,
    version: row.version,
    updatedAt: toUtcIso(row.updatedAt),
    updatedById: row.updatedById ?? row.createdById,
  }
}
export type FeeRuleView = ReturnType<typeof feeRuleView>
