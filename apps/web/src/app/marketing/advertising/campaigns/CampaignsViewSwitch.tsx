'use client'

/**
 * PC.1 — View switch for the campaigns page. Product-centric ("By product") is
 * the default; the existing flat campaign cockpit ("By campaign") is preserved.
 * Choice persists to localStorage + the URL (?view=product|campaigns) so links
 * are shareable. The flat cockpit is rendered untouched.
 */

import { useEffect, useState, type ComponentProps } from 'react'
import { LayoutGrid, List } from 'lucide-react'
import { AdCampaignsCockpit } from './AdCampaignsCockpit'
import { ByProductView } from './ByProductView'

type View = 'product' | 'campaign'

export function CampaignsViewSwitch({ initial }: { initial: ComponentProps<typeof AdCampaignsCockpit>['initial'] }) {
  const [view, setView] = useState<View>('product')

  useEffect(() => {
    try {
      const v = new URLSearchParams(window.location.search).get('view')
      if (v === 'campaigns' || v === 'campaign') { setView('campaign'); return }
      if (v === 'product') { setView('product'); return }
      const s = localStorage.getItem('ax.campaigns.view.v1')
      if (s === 'campaign') setView('campaign')
    } catch { /* default product */ }
  }, [])

  const change = (v: View) => {
    setView(v)
    try { localStorage.setItem('ax.campaigns.view.v1', v) } catch { /* ignore */ }
    try {
      const u = new URL(window.location.href)
      u.searchParams.set('view', v === 'campaign' ? 'campaigns' : 'product')
      window.history.replaceState({}, '', u)
    } catch { /* ignore */ }
  }

  return (
    <div>
      <div className="inline-flex items-center rounded-lg border border-slate-200 dark:border-slate-700 p-0.5 mb-4 bg-slate-50 dark:bg-slate-900">
        {([['product', 'By product', LayoutGrid], ['campaign', 'By campaign', List]] as const).map(([v, label, Icon]) => (
          <button key={v} onClick={() => change(v)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md transition ${view === v ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-sm font-medium' : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}`}
            aria-pressed={view === v}>
            <Icon size={14} /> {label}
          </button>
        ))}
      </div>
      {view === 'product' ? <ByProductView /> : <AdCampaignsCockpit initial={initial} />}
    </div>
  )
}
