import type { Issue } from '../../core/errors'
import { SIZE_RUN_RULES, type SizeRunRule } from '../planned-orders/rules'

/**
 * The site's size-run rule as a setting (B-W2b-318, closing B-W2b-293's gap; PLN-068; PlanningSettings.sizeRunRule and
 * sizeGroups of B-W2b-286), pure: ONE_GRID keeps no groups; SIZE_GROUPS keeps 2 to 20 groups of 1 to 50 size codes (1 to
 * 20 characters, no space), each code in one group only. The …_planning_depth_w2b_guards trigger holds the same; this says
 * it first, in words, with the field. Switching to ONE_GRID clears the groups.
 */

export const SIZE_RUN_LIMITS = Object.freeze({ groups: { min: 2, max: 20 }, codes: { min: 1, max: 50 }, code: 20 })

export interface SizeRunValues {
  readonly sizeRunRule: SizeRunRule
  readonly sizeGroups: readonly (readonly string[])[]
}

export const DEFAULT_SIZE_RUN: SizeRunValues = Object.freeze({ sizeRunRule: 'ONE_GRID', sizeGroups: [] })

/** The stored groups, as the plan reads them (anything else: none). */
export function sizeGroupsOfJson(value: unknown): string[][] {
  if (!Array.isArray(value)) return []
  return value.filter((group): group is unknown[] => Array.isArray(group)).map((group) => group.filter((code): code is string => typeof code === 'string'))
}

/** The values after a change (ONE_GRID clears the groups the change does not name). */
export function mergeSizeRun(current: SizeRunValues, patch: { readonly sizeRunRule?: SizeRunRule | undefined; readonly sizeGroups?: readonly (readonly string[])[] | undefined }): SizeRunValues {
  const sizeRunRule = patch.sizeRunRule ?? current.sizeRunRule
  const sizeGroups = patch.sizeGroups !== undefined ? patch.sizeGroups.map((group) => group.map((code) => code.trim())) : sizeRunRule === 'ONE_GRID' ? [] : current.sizeGroups
  return { sizeRunRule, sizeGroups }
}

/** What is wrong with a size-run setting (empty when nothing is). */
export function sizeRunProblems(values: SizeRunValues, base = 'body'): Issue[] {
  const problems: Issue[] = []
  if (!(SIZE_RUN_RULES as readonly string[]).includes(values.sizeRunRule)) return [{ path: `${base}/sizeRunRule`, message: `Split a size run by ${SIZE_RUN_RULES.join(' or ')}.` }]
  const { groups, codes, code } = SIZE_RUN_LIMITS
  if (values.sizeRunRule === 'ONE_GRID') {
    if (values.sizeGroups.length > 0) problems.push({ path: `${base}/sizeGroups`, message: 'One grid keeps no size groups: clear them, or split the size run by SIZE_GROUPS.' })
    return problems
  }
  if (values.sizeGroups.length < groups.min || values.sizeGroups.length > groups.max) problems.push({ path: `${base}/sizeGroups`, message: `Size groups are ${groups.min} to ${groups.max} groups of sizes (one group is one grid).` })
  const seen = new Set<string>()
  values.sizeGroups.forEach((group, index) => {
    if (group.length < codes.min || group.length > codes.max) problems.push({ path: `${base}/sizeGroups/${index}`, message: `A size group lists ${codes.min} to ${codes.max} size codes.` })
    for (const size of group) {
      if (size.length < 1 || size.length > code || /\s/.test(size)) problems.push({ path: `${base}/sizeGroups/${index}`, message: `A size code is 1 to ${code} characters with no space (“${size}” is not).` })
      else if (seen.has(size)) problems.push({ path: `${base}/sizeGroups/${index}`, message: `Size ${size} is in two groups: a size is in one group only.` })
      seen.add(size)
    }
  })
  return problems
}
