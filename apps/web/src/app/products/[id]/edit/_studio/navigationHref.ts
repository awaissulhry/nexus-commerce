import type { ChannelOption, StudioScopeId, StudioTabId } from './types'

/** Channel shortcuts use the same atomic patch for normal clicks and native links. */
export function studioChannelViewPatch(scope: StudioScopeId, market: string | null, channel: ChannelOption, tab: StudioTabId): Record<string, string | undefined> {
  const view = { tab: tab === 'sheet' ? undefined : tab }
  if (scope === channel.id) return view
  return { ...view, scope: channel.id,
    market: market && channel.markets.includes(market) ? market : channel.markets[0],
    account: undefined, listing: undefined, rec: undefined, cell: undefined, chip: undefined }
}

export function studioChannelViewHref(pathname: string, search: string, scope: StudioScopeId, market: string | null, channel: ChannelOption, tab: StudioTabId): string {
  const next = new URLSearchParams(search)
  for (const [key, value] of Object.entries(studioChannelViewPatch(scope, market, channel, tab))) {
    if (value === undefined) next.delete(key)
    else next.set(key, value)
  }
  const query = next.toString()
  return pathname + (query ? `?${query}` : '')
}

/** Mirrors setTab: only the view changes; market, scope, language, record and filters survive. */
export function studioViewHref(pathname: string, search: string, tab: StudioTabId): string {
  const next = new URLSearchParams(search)
  if (tab === 'sheet') next.delete('tab')
  else next.set('tab', tab)
  const query = next.toString()
  return pathname + (query ? `?${query}` : '')
}
