'use client'

/**
 * UX.1 — the one global filter for the whole Reviews workspace: channel
 * (Amazon / eBay) × market (IT / DE / FR / ES). This is what makes the simplified
 * surface "channel- and market-specific" without per-tab controls. State lives in
 * the URL (?channel&market) so deep links + server components read it; mirrored to
 * localStorage so it sticks on return. Options come from /reviews/filter-options.
 */

import { useEffect, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { getBackendUrl } from '@/lib/backend-url'

const LS_KEY = 'reviews:filter:v1'
const chLabel = (c: string) => (c === 'AMAZON' ? 'Amazon' : c === 'EBAY' ? 'eBay' : c === 'SHOPIFY' ? 'Shopify' : c)

export function GlobalFilterBar() {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const channel = params.get('channel') ?? 'ALL'
  const market = params.get('market') ?? 'ALL'
  const [channels, setChannels] = useState<string[]>(['AMAZON', 'EBAY'])
  const [markets, setMarkets] = useState<{ code: string; name: string }[]>([])

  useEffect(() => {
    void fetch(`${getBackendUrl()}/api/reviews/filter-options`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => { if (d.channels?.length) setChannels(d.channels); if (d.markets?.length) setMarkets(d.markets) })
      .catch(() => {})
  }, [])

  // First load with no URL params → restore the last selection from localStorage.
  useEffect(() => {
    if (params.get('channel') || params.get('market')) return
    try {
      const saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null') as { channel?: string; market?: string } | null
      if (saved && ((saved.channel && saved.channel !== 'ALL') || (saved.market && saved.market !== 'ALL'))) {
        const p = new URLSearchParams(params.toString())
        if (saved.channel && saved.channel !== 'ALL') p.set('channel', saved.channel)
        if (saved.market && saved.market !== 'ALL') p.set('market', saved.market)
        router.replace(`${pathname}?${p.toString()}`, { scroll: false })
      }
    } catch { /* ignore */ }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const set = (key: 'channel' | 'market', val: string) => {
    const p = new URLSearchParams(params.toString())
    if (val === 'ALL') p.delete(key)
    else p.set(key, val)
    try { localStorage.setItem(LS_KEY, JSON.stringify({ channel: key === 'channel' ? val : channel, market: key === 'market' ? val : market })) } catch { /* ignore */ }
    router.replace(`${pathname}?${p.toString()}`, { scroll: false })
  }

  const chip = (active: boolean) =>
    `px-2.5 py-1 rounded-md text-xs font-medium border transition-colors ${
      active
        ? 'bg-blue-600 text-white border-blue-600'
        : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 border-default dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600'
    }`

  return (
    <div className="flex items-center gap-3 flex-wrap py-2.5">
      <div className="flex items-center gap-1.5" role="group" aria-label="Channel filter">
        <span className="text-[10px] uppercase tracking-wider text-tertiary font-semibold mr-0.5">Channel</span>
        <button className={chip(channel === 'ALL')} aria-pressed={channel === 'ALL'} onClick={() => set('channel', 'ALL')}>All</button>
        {channels.map((c) => <button key={c} className={chip(channel === c)} aria-pressed={channel === c} onClick={() => set('channel', c)}>{chLabel(c)}</button>)}
      </div>
      <span className="w-px h-5 bg-slate-200 dark:bg-slate-700" aria-hidden="true" />
      <div className="flex items-center gap-1.5" role="group" aria-label="Market filter">
        <span className="text-[10px] uppercase tracking-wider text-tertiary font-semibold mr-0.5">Market</span>
        <button className={chip(market === 'ALL')} aria-pressed={market === 'ALL'} onClick={() => set('market', 'ALL')}>All</button>
        {markets.map((m) => <button key={m.code} className={chip(market === m.code)} aria-pressed={market === m.code} onClick={() => set('market', m.code)} title={m.name}>{m.code}</button>)}
      </div>
    </div>
  )
}
