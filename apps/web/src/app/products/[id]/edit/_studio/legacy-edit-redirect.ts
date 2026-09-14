import { STUDIO_TABS } from './types'

export type EditSearchParams = Record<string, string | string[] | undefined>

/** Preserve the product and destination when converting historical editor links. */
export function studioEditHref(id: string, search: EditSearchParams): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(search)) {
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, item)
  }
  const oldTab = query.get('tab')
  const channel = oldTab?.match(/^(AMAZON|EBAY|ETSY|SHOPIFY)(?:__(\w+)|_GLOBAL)?$/)
  if (channel) {
    if (!query.has('scope')) query.set('scope', channel[1])
    if (channel[2] && !query.has('market')) query.set('market', channel[2])
    query.set('tab', 'sheet')
  } else if (oldTab === 'variations') query.set('tab', 'variants')
  else if (oldTab === 'timeline') query.set('tab', 'activity')
  else if (oldTab && !STUDIO_TABS.includes(oldTab as typeof STUDIO_TABS[number])) query.set('tab', 'sheet')
  const suffix = query.toString()
  return `/products/${encodeURIComponent(id)}/edit/studio${suffix ? `?${suffix}` : ''}`
}
