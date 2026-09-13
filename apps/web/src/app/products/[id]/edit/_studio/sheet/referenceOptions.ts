import { REFERENCE_FIELDS } from '@nexus/shared/reference-values'
import { getBackendUrl } from '@/lib/backend-url'

export type ReferenceField = 'descriptionThemeId' | 'merchant_shipping_group' | 'shippingTemplate' | 'shipping_profile_id' | 'shop_section_id' | 'return_policy_id' | 'readiness_state_id'
export const isReferenceField = (key: string): key is ReferenceField => ['descriptionThemeId', 'merchant_shipping_group', 'shippingTemplate', 'shipping_profile_id', 'shop_section_id', 'return_policy_id', 'readiness_state_id'].includes(key)
export interface ReferenceOption { value: string; label: string; title?: string; searchText?: string }
export interface ReferenceChoices { options: ReferenceOption[]; labels: Record<string, string> }
export interface ReferenceScope { market?: string; productType?: string | null; connectionId?: string }
const cache = new Map<string, { expires: number; pending: boolean; value: Promise<ReferenceChoices> }>()

/** Metadata only. Inactive themes keep their names but cannot become new assignments. */
export function descriptionThemeChoices(body: unknown): ReferenceChoices {
  const themes = (body as { themes?: unknown })?.themes
  if (!Array.isArray(themes) || themes.some(theme => !theme || typeof theme.id !== 'string' || !theme.id || typeof theme.name !== 'string' || !theme.name.trim() || typeof theme.active !== 'boolean' || typeof theme.isDefault !== 'boolean')) throw new Error('Theme names returned an incomplete response. Try again.')
  const defaultTheme = themes.find(theme => theme.active && theme.isDefault)
  const defaults = { value: '', label: defaultTheme ? `Default theme · ${defaultTheme.name}` : 'Default theme', searchText: 'Default theme' }
  const labels = Object.fromEntries(themes.map(theme => [theme.id, theme.name]))
  return { labels: { ...labels, none: 'No theme' }, options: [defaults, { value: 'none', label: 'No theme' }, ...themes.filter(theme => theme.active).map(theme => ({ value: theme.id, label: theme.name, title: `${theme.name}\nID: ${theme.id}`, searchText: `${theme.name} ${theme.id}` }))] }
}

/**
 * How this read may be answered.
 *
 * 🔴 `live` is REQUIRED, not defaulted (LX.6 / R-LX-4, `reference_explicit_flag_beats_inference`).
 * Every caller states whether an operator asked for this list — a page load never has, and
 * `?live=1` is the only thing that lets the server talk to Amazon. Deriving it from `refresh` one
 * line away is exactly the shape that let a display lookup buy a live `auth/o2/token` round trip on
 * every cold Studio load; a new caller that forgets it is a COMPILE error rather than a leak.
 */
export interface ReferenceReadIntent {
  /** An operator gesture asked for this list (the cell editor opening, a write-recovery read). */
  live: boolean
  /** Ignore a warm client-side entry — orthogonal to `live`. */
  refresh?: boolean
}

export async function loadReferenceChoices(field: ReferenceField, scope: ReferenceScope, intent: ReferenceReadIntent): Promise<ReferenceChoices> {
  const { live, refresh = false } = intent
  const theme = field === 'descriptionThemeId'
  const etsy = REFERENCE_FIELDS[field].channel === 'ETSY'
  if (etsy && !scope.connectionId) throw new Error('Choose an Etsy account before selecting a resource.')
  if (!theme && !etsy && (!scope.market || !scope.productType)) throw new Error('Choose a product type and marketplace before selecting a shipping template.')
  const key = theme ? 'themes' : JSON.stringify([etsy ? field : 'shippingTemplate', scope.market, scope.productType, scope.connectionId ?? 'primary'])
  const hit = cache.get(key)
  if (hit && (hit.pending || (!refresh && hit.expires > Date.now()))) return hit.value
  const path = etsy ? `etsy/information/references?${new URLSearchParams({ accountId: scope.connectionId!, field })}` : theme ? 'ebay/description-themes?view=options' : `categories/reference-labels?${new URLSearchParams({ marketplace: scope.market!, productType: scope.productType!, shipping: '1', ...(live ? { live: '1' } : {}), ...(scope.connectionId ? { accountId: scope.connectionId } : {}) })}`
  const pending = (async () => {
    let response: Response
    try { response = await fetch(`${getBackendUrl()}/api/${path}`, { credentials: 'include', signal: AbortSignal.timeout(20_000) }) }
    catch { throw new Error(`${REFERENCE_FIELDS[field].label} names could not connect. Check your connection and try again.`) }
    const body = await response.json().catch(() => null)
    if (!response.ok) throw new Error(`${REFERENCE_FIELDS[field].label} names are unavailable. Try again.`)
    if (theme) return descriptionThemeChoices(body)
    if (etsy) {
      if (!Array.isArray(body?.choices) || body.choices.some((choice: any) => typeof choice.id !== 'string' || typeof choice.name !== 'string')) throw new Error('Etsy returned an incomplete resource list.')
      return { labels: Object.fromEntries(body.choices.map((choice: any) => [choice.id, choice.name])),
        options: [{ value: '', label: 'Not set' }, ...body.choices.filter((choice: any) => choice.active !== false).map((choice: any) => ({ value: choice.id, label: choice.name, title: `${choice.name} · ID: ${choice.id}`, searchText: `${choice.name} ${choice.id}` }))] }
    }
    if (body?.unavailable != null && !Array.isArray(body.unavailable)) throw new Error('Shipping-template names returned an incomplete response. Try again.')
    if (body?.unavailable?.includes('shippingTemplate')) throw new Error('Shipping-template names are unavailable. Check the Amazon connection in Connections, then try again.')
    const names = body?.labels?.merchant_shipping_group
    if (!names || typeof names !== 'object' || Array.isArray(names) || Object.values(names).some(name => typeof name !== 'string' || !name.trim())) throw new Error('Shipping-template names returned an incomplete response. Try again.')
    const labels = names as Record<string, string>
    return { labels, options: [{ value: '', label: 'Not set' }, ...Object.entries(labels).map(([value, label]) => ({ value, label, title: `${label}\nID: ${value}`, searchText: `${label} ${value}` }))] }
  })().then(choices => {
    const entry = cache.get(key)
    if (entry?.value === pending) entry.pending = false
    return choices
  }).catch(error => { if (cache.get(key)?.value === pending) cache.delete(key); throw error })
  cache.set(key, { expires: Date.now() + 60_000, pending: true, value: pending })
  return pending
}
