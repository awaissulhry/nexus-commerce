import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { StudioClient } from '@/app/products/[id]/edit/_studio/StudioClient'
import { Button } from '@/design-system/primitives'
import '@/design-system/styles/tokens-global.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import '@/design-system/styles/patterns.css'
import '@/design-system/styles/a11y.css'
import './style.css'
const product = { id: 'store-demo', sku: 'TOURING-JACKET', name: 'Jackets', status: 'DRAFT', isParent: true, parentId: null, productType: null, asin: null }
const marketplaces = ['SHOPIFY', 'ETSY'].map(channel => ({ id: channel, channel, code: 'GLOBAL', name: channel === 'SHOPIFY' ? 'Shopify' : 'Etsy', language: 'en', connected: true, accounts: [{ id: channel.toLowerCase(), label: `${channel === 'SHOPIFY' ? 'Shopify' : 'Etsy'} demo store`, primary: true }] }))
function TimingEvidence() {
  const [samples, setSamples] = useState<number[]>([])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!(event.target instanceof HTMLElement) || !event.target.closest('[role=grid]')) return
      const at = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => setSamples(old => [...old.slice(-199), performance.now() - at])))
    }
    document.addEventListener('keydown', key, true); return () => document.removeEventListener('keydown', key, true)
  }, [])
  const sorted = [...samples].sort((a,b)=>a-b)
  return <span aria-label="QA input timing">{samples.length} keyboard samples · p95 next-paint proxy {sorted.length ? sorted[Math.ceil(sorted.length*.95)-1].toFixed(1) : '—'} ms</span>
}
createRoot(document.getElementById('root')!).render(<><div className="qa-bar"><span>Isolated Information QA</span><TimingEvidence /><Button size="xs" onClick={() => { void fetch("/api/fixture/mode", { method: "POST", body: JSON.stringify({ mode: "performance" }) }).then(() => location.reload()) }}>10,000 variants</Button><Button size="xs" onClick={() => { void fetch("/api/fixture/mode", { method: "POST", body: JSON.stringify({ mode: "conflict" }) }) }}>Conflict on next save</Button><Button size="xs" onClick={() => { void fetch("/api/fixture/mode", { method: "POST", body: JSON.stringify({ mode: "interrupt" }) }) }}>Interrupt next sync</Button><Button size="xs" variant="secondary" onClick={() => document.documentElement.classList.toggle('dark')}>Toggle theme</Button></div><main id="main-content"><StudioClient product={product} family={null} marketplaces={marketplaces} marketplacesFailed={false} /></main></>)
