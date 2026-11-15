import { NO_KEY, returnGroupsOf, type ReturnEntry, type ReturnFigures } from '@nexus/factory-domain/insights/sales-reports/rules'
import type { Reader } from './access'

/**
 * Return reasons by group (B-W2b-380, XF6:06; SAL-458 "Returns by reason group, model, size, colour, customer"): the RETURN
 * list's codes carry the words of their group (ReasonCode.group, B-W2b-363: one line, 1-120 characters; the same words are one
 * group). The return lines of the period fold by their reason's group, the most pieces first; a reason without a group (or a
 * code no longer in the list) falls in NO_KEY ("no group"). The group is the tenant's own words, never translated.
 */

export interface ReasonGroup {
  /** The group's words, or NO_KEY for the reasons without a group. */
  readonly key: string
  /** The reason codes the period's lines name in this group, in code order. */
  readonly reasons: readonly string[]
  readonly figures: ReturnFigures
}

/** The group of each RETURN code the lines name (null: none). */
export async function reasonGroupOf(db: Reader, codes: readonly string[]): Promise<Map<string, string | null>> {
  const wanted = [...new Set(codes)]
  if (wanted.length === 0) return new Map()
  const rows = await db.reasonCode.findMany({ where: { list: 'RETURN', code: { in: wanted } }, select: { code: true, group: true } })
  const found = new Map(rows.map((row) => [row.code, row.group?.trim() ? row.group.trim() : null]))
  return new Map(wanted.map((code) => [code, found.get(code) ?? null]))
}

/** The lines folded by their reason's group (the domain's grouping, keyed by the group instead of the code). */
export function reasonGroupsOf(rows: readonly ReturnEntry[], groupOf: ReadonlyMap<string, string | null>, companyCurrency: string | null): ReasonGroup[] {
  const keyOf = (reason: string) => groupOf.get(reason) ?? NO_KEY
  return returnGroupsOf(
    rows.map((row) => ({ ...row, reason: keyOf(row.reason) })),
    'reason',
    companyCurrency,
  ).map((group) => ({ key: group.key, reasons: [...new Set(rows.filter((row) => keyOf(row.reason) === group.key).map((row) => row.reason))].sort(), figures: group.figures }))
}
