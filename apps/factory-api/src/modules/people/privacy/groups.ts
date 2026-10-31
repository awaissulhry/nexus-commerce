import { DomainError } from '@nexus/factory-domain/core/errors'
import { maskSmallGroups, minimumGroupOf, personKeyProblems, type GroupRow } from '@nexus/factory-domain/people/privacy/groups'
import type { CommandTx } from '../../../core/command'

/**
 * The minimum group size and the privacy settings of a company (B-W2b-27; ANA-075, MES-249; PeopleSettings, one row per
 * company with the company's id; none: the defaults, groups of 3 and nobody but the worker sees one person's figures).
 *
 * For the later People reads (efficiency, attendance totals, People reports, the line boards):
 *   privacySettingsFor(db, companyId)       { minimumGroupSize, figureRoleKeys, version }
 *   minimumGroupSizeFor(db, companyId)      the company's minimum (never below the floor of 3)
 *   hideSmallGroups(db, companyId, rows)    empties every group under the minimum before the answer (and its headcount)
 *   refusePersonKeys({ groupBy, filters })  400 when a people figures read groups, filters or sorts by a person
 * The floor may read PeopleSettings (no site key, nothing personal in it).
 */

export type SettingsReader = Pick<CommandTx, 'peopleSettings'>

export interface PrivacySettings {
  readonly minimumGroupSize: number
  readonly figureRoleKeys: string[]
  /** The row's version; null while the company has no People settings (the defaults). */
  readonly version: number | null
}

export async function privacySettingsFor(db: SettingsReader, companyId: string): Promise<PrivacySettings> {
  const row = await db.peopleSettings.findUnique({ where: { id: companyId }, select: { minimumGroupSize: true, figureRoleKeys: true, version: true } })
  return { minimumGroupSize: minimumGroupOf(row), figureRoleKeys: [...(row?.figureRoleKeys ?? [])], version: row?.version ?? null }
}

export async function minimumGroupSizeFor(db: SettingsReader, companyId: string): Promise<number> {
  return (await privacySettingsFor(db, companyId)).minimumGroupSize
}

export async function hideSmallGroups<Row extends GroupRow>(db: SettingsReader, companyId: string, rows: readonly Row[]) {
  return maskSmallGroups(rows, await minimumGroupSizeFor(db, companyId))
}

export function refusePersonKeys(input: { readonly groupBy?: readonly string[]; readonly filters?: readonly string[]; readonly sort?: readonly string[] }): void {
  const problems = personKeyProblems(input)
  if (problems.length > 0) throw new DomainError('validation_failed', problems[0]!.message, problems)
}
