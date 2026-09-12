import { axisSynonymKey, storedPresentationValues } from '../../ebay-theme-axes.js'
import { orderAxisValues } from '../../ebay-value-order.js'

export interface PresentationRule {
  id: string; name: string; version: number; priority: number
  scope: { accountId?: string; familyId?: string; sharedCategoryId?: string; marketplaceCategoryId?: string }
  themeId?: string
  order?: { axes: string[]; values: Record<string, string[]> }
}
export interface PresentationContext {
  accountId: string | null; familyId: string; sharedCategoryIds: string[]; marketplaceCategoryId: string | null
}
export interface PresentationValue<T> { value: T | undefined; rule: PresentationRule | null; conflicts: string[] }

export function matchesPresentationScope(scope: PresentationRule['scope'], context: PresentationContext) {
  return (!scope.accountId || scope.accountId === context.accountId) &&
    (!scope.familyId || scope.familyId === context.familyId) &&
    (!scope.sharedCategoryId || context.sharedCategoryIds.includes(scope.sharedCategoryId)) &&
    (!scope.marketplaceCategoryId || scope.marketplaceCategoryId === context.marketplaceCategoryId)
}

export function validatePresentationRule(rule: PresentationRule): string[] {
  const errors: string[] = []
  if (!rule || typeof rule !== 'object') return ['Choose a presentation rule']
  if (typeof rule.id !== 'string' || !rule.id.trim() || typeof rule.name !== 'string' || !rule.name.trim() || rule.name.length > 200) errors.push('A rule needs an ID and a name of 1–200 characters')
  if (!Number.isInteger(rule.priority) || rule.priority < 0 || rule.priority > 100) errors.push('Priority must be an integer from 0 to 100; the highest matching priority wins')
  if (!Number.isInteger(rule.version) || rule.version < 0) errors.push('A rule version must be a nonnegative integer')
  if (!rule.scope || typeof rule.scope !== 'object' || Array.isArray(rule.scope)) errors.push('Choose the matching scope')
  else for (const [key, value] of Object.entries(rule.scope)) {
    if (!['accountId', 'familyId', 'sharedCategoryId', 'marketplaceCategoryId'].includes(key) || typeof value !== 'string' || !value.trim()) errors.push(`Unsupported or empty matching dimension: ${key}`)
  }
  if (!rule.themeId && !rule.order) errors.push('Choose a theme or variation order')
  if (rule.themeId !== undefined && (typeof rule.themeId !== 'string' || !rule.themeId.trim())) errors.push('Choose an active theme, or none')
  if (rule.order) {
    const { axes, values } = rule.order
    if (!Array.isArray(axes) || axes.length > 5 || axes.some(a => typeof a !== 'string' || !a.trim()) || new Set(axes.map(axisSynonymKey)).size !== axes.length) errors.push('Choose at most five distinct variation axes')
    if (!values || typeof values !== 'object' || Array.isArray(values)) errors.push('Value order must be keyed by variation axis')
    else {
      if (new Set(Object.keys(values).map(axisSynonymKey)).size !== Object.keys(values).length) errors.push('Each variation dimension can have only one value order')
      for (const [axis, list] of Object.entries(values)) {
      if (!axis.trim() || !Array.isArray(list) || list.length > 500 || list.some(v => typeof v !== 'string' || !v.trim()) || new Set(list.map(v => v.trim().toLowerCase())).size !== list.length) errors.push(`Invalid or duplicate ordered values for ${axis}`)
      }
    }
  }
  return errors
}

/** Priority is explicit, never guessed from the number of scope selectors. Ties that disagree
 * are visible conflicts, including for future eligible products. Explicit listing values win
 * per property at the call site, so a theme override cannot suppress an inherited value order.
 */
export function effectivePresentationRule<K extends 'themeId' | 'order'>(rules: PresentationRule[], context: PresentationContext, property: K): PresentationValue<PresentationRule[K]> {
  const matches = rules.filter(r => r[property] !== undefined && matchesPresentationScope(r.scope, context))
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
  const top = matches.filter(r => r.priority === matches[0]?.priority)
  if (new Set(top.map(r => JSON.stringify(r[property]))).size > 1) return { value: undefined, rule: null, conflicts: top.map(r => `${r.name} (${r.id}, priority ${r.priority})`) }
  return { value: top[0]?.[property], rule: top[0] ?? null, conflicts: [] }
}

/** Uses the existing eBay ordering authority; unknown values keep its deterministic fallback. */
export function applyPresentationOrder(axes: Array<{ name: string; key: string; values: string[] }>, order: PresentationRule['order']) {
  if (!order) return axes
  const rank = new Map(order.axes.map((axis, index) => [axisSynonymKey(axis), index]))
  const values = Object.fromEntries(Object.entries(order.values).map(([key, list]) => [axisSynonymKey(key), list]))
  return axes.map(axis => ({ ...axis, values: orderAxisValues(axis.name, axis.values, values[axisSynonymKey(axis.name)]) }))
    .sort((a, b) => (rank.get(axisSynonymKey(a.name)) ?? 99) - (rank.get(axisSynonymKey(b.name)) ?? 99))
}

export function resolvePresentationOrder(rules: PresentationRule[], context: PresentationContext, attrs: Record<string, unknown>) {
  const axes = Array.isArray(attrs._variationAxes) ? attrs._variationAxes.filter((v): v is string => typeof v === 'string') : undefined
  const stored = storedPresentationValues(attrs)
  const matching = rules.filter(r => r.order && matchesPresentationScope(r.scope, context)).sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
  const conflicts: string[] = []
  const supplied: PresentationRule[] = []
  const pick = (property: string, read: (rule: PresentationRule) => string[] | undefined): string[] | undefined => {
    const candidates = matching.filter(r => read(r) !== undefined)
    const top = candidates.filter(r => r.priority === candidates[0]?.priority)
    if (new Set(top.map(r => JSON.stringify(read(r)))).size > 1) { conflicts.push(`${property}: ${top.map(r => `${r.name} (${r.id}, priority ${r.priority})`).join('; ')}`); return undefined }
    if (top[0]) supplied.push(top[0])
    return top[0] ? read(top[0]) : undefined
  }
  const inheritedAxes = axes === undefined ? pick('Axis order', r => r.order?.axes.length ? r.order.axes : undefined) : undefined
  const values: Record<string, string[]> = { ...stored }
  const dimensions = new Set(matching.flatMap(r => Object.keys(r.order?.values ?? {}).map(axisSynonymKey)))
  for (const key of dimensions) if (!(key in stored)) {
    const order = pick(`Values for ${key}`, r => Object.entries(r.order?.values ?? {}).find(([axis]) => axisSynonymKey(axis) === key)?.[1])
    if (order) values[key] = order
  }
  return { value: { axes: axes ?? inheritedAxes ?? [], values }, rule: supplied.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))[0] ?? null,
    conflicts, explicitAxes: axes !== undefined, explicitValues: Object.keys(stored) }
}
